import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { startBot, stopBot, getBotStatus } from "./src/services/discordBot.ts";
import { startBusinessBot, stopBusinessBot } from "./src/services/businessBot.ts";
import { startDashboardServer } from "./src/services/dashboardServer.ts";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Simple HTML status page — "we're definitely a web service" mask
app.get("/", (_req, res) => {
  const status = getBotStatus();
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NotABot Service</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0d0d0f;
      color: #e2e2e2;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #1a1a1f;
      border: 1px solid #2a2a35;
      border-radius: 16px;
      padding: 48px 56px;
      text-align: center;
      max-width: 420px;
      box-shadow: 0 0 60px rgba(88, 101, 242, 0.08);
    }
    .dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: ${status === "running" ? "#23c55e" : "#ef4444"};
      margin-right: 8px;
      box-shadow: 0 0 8px ${status === "running" ? "#23c55e88" : "#ef444488"};
    }
    h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 8px; }
    .subtitle { color: #666; font-size: 0.9rem; margin-bottom: 32px; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      background: #0d0d0f;
      border: 1px solid #2a2a35;
      border-radius: 999px;
      padding: 8px 20px;
      font-size: 0.85rem;
      font-weight: 500;
    }
    .footer { margin-top: 32px; font-size: 0.75rem; color: #444; }
  </style>
</head>
<body>
  <div class="card">
    <h1>NotABot</h1>
    <p class="subtitle">Discord Service — Web Interface</p>
    <div class="status-badge">
      <span class="dot"></span>
      Service ${status === "running" ? "Online" : "Offline"}
    </div>
    <div style="margin-top: 24px;">
      <a href="http://localhost:4400" style="display: inline-block; padding: 10px 24px; background: #5865F2; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 0.9rem; transition: background 0.2s;">
        Open Advanced Dashboard
      </a>
    </div>
    <p class="footer">© ${new Date().getFullYear()} NotABot · All systems nominal</p>
  </div>
</body>
</html>`);
});

// Health / status API
app.get("/api/status", (_req, res) => {
  res.json({
    status: "ok",
    botStatus: getBotStatus(),
    timestamp: new Date().toISOString(),
  });
});

// Start / stop endpoints (optional, handy for manual control)
app.post("/api/bot/start", async (req, res) => {
  try {
    const token = process.env.DISCORD_TOKEN || req.body?.token;
    const businessToken = process.env.BUSINESS_BOT_TOKEN || req.body?.businessToken;
    if (!token) return res.status(400).json({ error: "DISCORD_TOKEN missing" });
    
    const promises = [startBot(token)];
    if (businessToken) promises.push(startBusinessBot(businessToken));
    
    await Promise.all(promises);
    res.json({ message: "Bots started" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/bot/stop", (_req, res) => {
  stopBot();
  stopBusinessBot();
  res.json({ message: "Bots stopped" });
});

// Boot
app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`[server] Running on http://localhost:${PORT}`);

  if (process.env.DISCORD_TOKEN) {
    console.log("[server] Auto-starting Discord bot...");
    startBot(process.env.DISCORD_TOKEN).catch((err) =>
      console.error("[server] Bot start failed:", err.message)
    );
  } else {
    console.warn("[server] DISCORD_TOKEN not set — bot not started.");
  }

  if (process.env.BUSINESS_BOT_TOKEN) {
    console.log("[server] Auto-starting Business bot...");
    startBusinessBot(process.env.BUSINESS_BOT_TOKEN).catch((err) =>
      console.error("[server] BusinessBot start failed:", err.message)
    );
  } else {
    console.warn("[server] BUSINESS_BOT_TOKEN not set — business bot not started.");
  }
  
  startDashboardServer(4400);
});
