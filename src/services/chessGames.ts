import { Chess, Move } from 'chess.js';

export interface ChessGameState {
  chess: Chess;
  opponentId: string;
  opponentName: string;
  channelId: string;
}

export class ChessManager {
  // channelId -> Chess instance
  private games = new Map<string, ChessGameState>();

  public startGame(channelId: string, opponentId: string, opponentName: string): string {
    const chess = new Chess();
    this.games.set(channelId, { chess, opponentId, opponentName, channelId });
    return this.getBoardUrl(chess.fen());
  }

  public getGame(channelId: string): ChessGameState | undefined {
    return this.games.get(channelId);
  }

  public endGame(channelId: string) {
    this.games.delete(channelId);
  }

  public getBoardUrl(fen: string, lastMove?: string): string {
    const encodedFen = encodeURIComponent(fen);
    let url = `https://backscattering.de/web-boardimage/board.svg?fen=${encodedFen}`;
    if (lastMove) {
      url += `&lastMove=${lastMove}`;
    }
    return url;
  }

  // Returns true if the move was valid and applied
  public playUserMove(channelId: string, userId: string, move: string): boolean {
    const game = this.games.get(channelId);
    if (!game) return false;
    // We only let the opponent play, and only when it's white's turn (since NotABot is black)
    if (game.opponentId !== userId) return false;
    if (game.chess.turn() !== 'w') return false;

    try {
      const res = game.chess.move(move);
      return !!res;
    } catch {
      return false; // Invalid move
    }
  }

  // Bot plays a move, either chosen by AI or fallback to random if AI fails
  public playBotMove(channelId: string, move: string): boolean {
    const game = this.games.get(channelId);
    if (!game) return false;
    if (game.chess.turn() !== 'b') return false;

    try {
      const res = game.chess.move(move);
      return !!res;
    } catch {
      return false;
    }
  }

  public playRandomBotMove(channelId: string): string | null {
    const game = this.games.get(channelId);
    if (!game) return null;
    if (game.chess.turn() !== 'b') return null;

    const moves = game.chess.moves();
    if (moves.length === 0) return null;

    const move = moves[Math.floor(Math.random() * moves.length)];
    game.chess.move(move);
    return move;
  }
}

export const chessManager = new ChessManager();
