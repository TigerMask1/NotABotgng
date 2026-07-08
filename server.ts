import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { startBot, stopBot, getBotStatus, getGeminiStats } from "./src/services/discordBot.ts";
import { db } from "./src/services/firebase.ts";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/status", (req, res) => {
    res.json({ 
      status: "ok", 
      botStatus: getBotStatus(),
      hasToken: !!process.env.DISCORD_TOKEN,
      hasAiKey: !!process.env.GEMINI_API_KEY
    });
  });

  app.post("/api/bot/start", async (req, res) => {
    try {
      const token = process.env.DISCORD_TOKEN || req.body.token;
      if (!token) {
        return res.status(400).json({ error: "Discord token missing" });
      }
      await startBot(token);
      res.json({ message: "Bot started" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // live per-key request/error/429 counts and per-model token usage, straight
  // from GeminiManager's in-memory tracking — resets at midnight Pacific,
  // same boundary Google uses for RPD, so this should track what AI Studio
  // shows. poll this on an interval from the frontend (5-10s is plenty;
  // there's no websocket here, just cheap in-memory reads).
  app.get("/api/gemini/stats", (req, res) => {
    try {
      res.json(getGeminiStats());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // memory is stored as one doc per scope in `memoryStore`, keyed
  // "server:{guildId}" or "person:{userId}", each holding an `entries` array
  // of { kind, text, salience, ... }. this used to read old insideJokes/
  // currentMood fields that no longer exist anywhere in the current bot —
  // stale leftover from before the memory engine rewrite.
  app.get("/api/memory", async (req, res) => {
    try {
      const snapshot = await db.collection('memoryStore').limit(50).get();
      const memory: any[] = [];

      for (const doc of snapshot.docs) {
        if (!doc.id.startsWith('server:')) continue; // person: entries aren't tied to one guild, skip for this per-server view
        const guildId = doc.id.slice('server:'.length);
        const entries: any[] = doc.data()?.entries ?? [];
        const byKind: Record<string, string[]> = {};
        for (const e of entries) {
          (byKind[e.kind] ??= []).push(e.text);
        }
        memory.push({ guildId, entryCount: entries.length, byKind });
      }
      res.json(memory);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/bot/stop", (req, res) => {
    stopBot();
    res.json({ message: "Bot stopped" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Auto-start bot if token is in env
    if (process.env.DISCORD_TOKEN) {
      console.log("Auto-starting Discord bot...");
      startBot(process.env.DISCORD_TOKEN).catch(err => {
        console.error("Auto-start failed:", err.message);
      });
    }
  });
}

startServer();
