# SGYT ENGINE — Render Edition

Direct-link video URL extractor. No GitHub Actions, no GitLab CI, no Pusher.

## How it works

The backend is a plain Node.js server deployed on Render.com's free tier.
When the frontend POSTs a YouTube URL, the server runs `yt-dlp --get-url` as
a child process (takes ~5–10s), and returns the CDN-signed URL in the HTTP
response body. The browser opens that URL directly.

```
Browser → POST /extract → Render server → yt-dlp --get-url → CDN URL → Browser
```

## Quality limit

YouTube serves 720p and below as pre-muxed (combined video+audio) streams.
At 1080p+, YouTube splits video and audio into separate DASH streams — two
URLs that a browser can't merge. So the maximum quality via direct link
is **720p**. For 1080p you'd need server-side muxing (back to the download
approach). "best" quality in this app is capped at 720p intentionally.

## Deploy to Render.com (5 minutes)

1. Push this folder to any GitHub repo (public or private).
2. Go to [render.com](https://render.com) → New → Web Service → connect the repo.
3. Render auto-detects `render.yaml` — click **Deploy**.
4. Once deployed, copy your service URL: `https://your-service.onrender.com`
5. Open `script.js` and update the one line:
   ```js
   API_BASE: 'https://your-service.onrender.com',
   ```
6. Re-upload `script.js` to your ProFreeHost.

That's it. No tokens to manage, no pipeline to configure.

## Cold start

Render's free tier sleeps after 15 minutes of inactivity. The first request
after sleep triggers a ~20–30s spin-up (the "WAKING SERVER..." state in the UI).
Subsequent requests are instant. To keep it warm, you can ping `/health` on a
schedule using a free service like [UptimeRobot](https://uptimerobot.com).

## Environment variables (optional)

Set these in Render dashboard → your service → Environment:

| Variable | Default | Purpose |
|----------|---------|---------|
| `API_KEY` | *(empty)* | If set, clients must send `X-API-Key: <value>` |
| `CORS_ORIGIN` | `*` | Restrict to your frontend domain, e.g. `https://yourdomain.com` |
| `RATE_LIMIT` | `10` | Max requests per IP per minute |
