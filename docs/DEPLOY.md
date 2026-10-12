# Deploying VibeScore to Render (free tier)

VibeScore stores its data in a single SQLite file. Render's free web service
plan has no persistent disk and the container can restart or sleep after
about 15 minutes of inactivity, so anything written to disk would normally
be lost. This setup uses [Litestream](https://litestream.io) to continuously
copy the SQLite file to an S3-compatible bucket (Backblaze B2's free tier)
and restore it automatically whenever the container starts.

## 1. Create a Backblaze B2 bucket

1. Sign up at [backblaze.com/b2](https://www.backblaze.com/cloud-storage) (free, no card required for the free tier: 10 GB storage).
2. In the B2 console, create a new bucket. Make it **private**. Name it anything, e.g. `vibescore-backups`.
3. Go to **App Keys** → **Add a New Application Key**.
   - Restrict it to the bucket you just created.
   - Give it read and write access.
   - Save the **keyID** and **applicationKey** shown after creation — the applicationKey is only shown once.
4. Note your bucket's **S3-compatible endpoint** and **region**, shown on the bucket details page, e.g.:
   - Endpoint: `https://s3.us-west-004.backblazeb2.com`
   - Region: `us-west-004`

You'll enter these values into Render in step 2.

## 2. Deploy on Render

1. Sign up at [render.com](https://render.com) (free) and connect your GitHub account.
2. Push this repository to GitHub if it isn't already there.
3. In the Render dashboard, click **New → Blueprint** and select this repository. Render reads `render.yaml` and proposes one service, `vibescore`.
4. Render will prompt for the environment variables marked `sync: false` in `render.yaml`. Fill in:
   - `LITESTREAM_BUCKET` — your B2 bucket name (e.g. `vibescore-backups`)
   - `LITESTREAM_ENDPOINT` — your B2 endpoint (e.g. `https://s3.us-west-004.backblazeb2.com`)
   - `LITESTREAM_REGION` — your B2 region (e.g. `us-west-004`)
   - `LITESTREAM_ACCESS_KEY_ID` — the B2 application key's **keyID**
   - `LITESTREAM_SECRET_ACCESS_KEY` — the B2 **applicationKey**
   - `PUBLIC_ORIGIN` — leave blank (see step 3)
   - `AI_API_KEY`, `AI_MODEL` — optional, see step 4
5. Click **Apply**. Render builds the Docker image and deploys it. The first deploy has no existing backup, so Litestream starts with a fresh, empty database.

## 3. Public URL and custom domains

Render injects your service URL (e.g. `https://vibescore-abcd.onrender.com`) as `RENDER_EXTERNAL_URL`, and VibeScore uses it automatically for same-origin request checks and Secure cookies. Nothing to configure.

If you later add a **custom domain**, set `PUBLIC_ORIGIN` to that exact URL (e.g. `https://vibescore.dev`, no trailing slash) in the **Environment** tab and save to redeploy.

## 4. Optional: enable the AI coach

The AI coach and semantic drill review need a standard API key (not a coding-tool subscription). The free tier of [Google AI Studio](https://aistudio.google.com/apikey) works with the default `gemini` provider:

1. Create a key at Google AI Studio (no card required).
2. In Render's **Environment** tab, set `AI_API_KEY` to that key and `AI_MODEL` to `gemini-3.8-flash` (or any Flash model listed in AI Studio).
3. Save to redeploy. Leave `AI_API_KEY` blank to keep the AI coach disabled — challenges, the code runner, and scoring all work without it.

Privacy note: on Gemini's free tier, Google may use request content to improve its products. Coach messages and drill answers are sent to the provider (never workflow telemetry, which stays numeric). Switch to a paid key if that matters for your users, and say so on your privacy page.

## 5. Verify backups are working

- **Render logs**: open the service's **Logs** tab. On boot you should see `docker-entrypoint: restoring ... from replica` followed by Litestream's own startup lines, then `docker-entrypoint: starting app under litestream replicate`. You should NOT see the "LITESTREAM_BUCKET is not set" warning.
- **B2 bucket**: open your bucket in the Backblaze console. Within a few seconds of the app receiving writes, you should see objects appear under the `vibescore/` path.
- **Restart persistence**: in Render, manually restart the service (Manual Deploy → Deploy, or the restart button). After it comes back up, confirm your data (e.g. a score or user you created) is still there. This proves restore-on-boot is working, not just replication.

## 6. Limits to know about

- **Sleep + cold start**: the free plan spins the service down after ~15 minutes idle. The next request wakes it up, which takes a bit longer while Litestream restores the database and the app boots.
- **Single instance only**: never scale this service to more than one instance. Multiple instances writing to the same SQLite file (even via Litestream) will corrupt data — Litestream assumes one writer.
- **Backblaze B2 free tier**: 10 GB storage and limited free daily download; a small VibeScore SQLite database with daily snapshots and a week of retention should stay well within this on a single instance.

## Run the production image locally

Build and run the same Docker image used on Render:

```sh
docker build -t vibescore-test .

# Without Litestream (ephemeral data, matches a plain local run):
docker run --rm -p 8787:8787 \
  -e PUBLIC_ORIGIN=http://localhost:8787 \
  vibescore-test

# With Litestream, replicating to a real B2/S3-compatible bucket:
docker run --rm -p 8787:8787 \
  -e PUBLIC_ORIGIN=http://localhost:8787 \
  -e LITESTREAM_BUCKET=your-bucket \
  -e LITESTREAM_ENDPOINT=https://s3.us-west-004.backblazeb2.com \
  -e LITESTREAM_REGION=us-west-004 \
  -e LITESTREAM_ACCESS_KEY_ID=your-key-id \
  -e LITESTREAM_SECRET_ACCESS_KEY=your-application-key \
  vibescore-test
```

Then open `http://localhost:8787` and check `http://localhost:8787/api/status` returns `200`.
