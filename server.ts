import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { startBot, stopBot, getBotStatus } from "./src/services/discordBot.ts";
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
