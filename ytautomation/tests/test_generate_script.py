import os
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))

from generate_script import build_script_metadata_from_queue_item, build_script_from_queue_item, load_queue_payload


class GenerateScriptTests(unittest.TestCase):
    def test_build_script_metadata_from_queue_item_includes_avatars_and_attachments(self):
        payload = {
            'messages': [
                {
                    'author': 'Jaguar',
                    'content': 'lmao yes do it',
                    'avatarUrl': 'https://cdn.discordapp.com/avatars/1/avatar.png',
                    'attachmentUrls': ['https://example.com/meme.png']
                },
                {
                    'author': 'NOTABOT',
                    'content': 'clip this for a short',
                    'avatarUrl': 'https://cdn.discordapp.com/avatars/2/avatar.png',
                    'attachmentUrls': []
                },
            ]
        }

        metadata = build_script_metadata_from_queue_item(payload)

        self.assertIn('Jaguar', metadata['characters'])
        self.assertEqual(metadata['characters']['Jaguar']['avatar_url'], 'https://cdn.discordapp.com/avatars/1/avatar.png')
        self.assertEqual(metadata['attachments_by_message_index']['0'][0]['url'], 'https://example.com/meme.png')

    def test_load_queue_payload_uses_first_pending_firestore_item(self):
        fake_doc = Mock()
        fake_doc.to_dict.return_value = {
            'messages': [{'author': 'Jaguar', 'content': 'hi'}],
            'status': 'pending',
        }
        fake_doc.reference.update = Mock()

        class FakeQuery:
            def __init__(self, docs):
                self.docs = docs
            def where(self, *args, **kwargs):
                return self
            def order_by(self, *args, **kwargs):
                return self
            def limit(self, *args, **kwargs):
                return self
            def stream(self):
                return self.docs

        fake_query = FakeQuery([fake_doc])

        fake_db = Mock()
        fake_db.collection.return_value = fake_query

        with patch('generate_script.get_firestore_client', return_value=fake_db):
            payload = load_queue_payload()

        self.assertEqual(payload['messages'][0]['author'], 'Jaguar')
        fake_doc.reference.update.assert_called_once()

    def test_build_script_from_queue_item_adds_media_cues_for_punchlines(self):
        payload = {
            'messages': [
                {'author': 'NOTABOT', 'content': 'i found your backup folder'},
                {'author': 'ducky', 'content': 'please do not open it'},
                {'author': 'NOTABOT', 'content': 'look at this photo of the disaster'}
            ]
        }

        script = build_script_from_queue_item(payload)

        self.assertIn('# GIF:', script)
        self.assertIn('# PHOTO:', script)

    def test_build_script_from_queue_item_surfaces_media_only_messages(self):
        payload = {
            'messages': [
                {
                    'author': 'ducky',
                    'content': '',
                    'reactionEmojiUrls': ['https://example.com/gif.gif'],
                }
            ]
        }

        script = build_script_from_queue_item(payload)

        self.assertIn('ducky:', script)
        self.assertIn('sent a gif', script.lower())
        self.assertIn('# GIF:', script)

    def test_build_script_from_queue_item_adds_notabot_pov_hook(self):
        payload = {
            'messages': [
                {'author': 'ducky', 'content': 'you ruined my birthday'},
                {'author': 'NOTABOT', 'content': 'i did not mean to'}
            ]
        }

        script = build_script_from_queue_item(payload)

        self.assertIn('ruined', script.lower())
        self.assertIn('birthday', script.lower())


if __name__ == '__main__':
    unittest.main()
