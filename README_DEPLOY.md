# ElevenLabs Image Generator — Render deployment

This package is configured for a Render Docker web service (free plan for testing).

## Deploy
1. Upload this folder to a GitHub repository.
2. In Render choose **New + → Web Service** and connect that repository.
3. Select **Docker** runtime and the **Free** instance plan.
4. Add environment variable `APP_PASSWORD` with a strong password before sharing the URL.
5. Deploy. First build can take several minutes because Playwright installs Chromium and Linux dependencies.

## Important limitations
- Render Free sleeps after 15 minutes without traffic and its local filesystem is ephemeral. Browser login/session and downloaded images may be lost after restart/redeploy/sleep.
- This app controls the ElevenLabs website through Playwright; site UI changes may break it. Use only with an account you are authorized to access and comply with ElevenLabs' terms.
- The service requires a real browser, so Hugging Face Static Spaces cannot host this backend. Hugging Face ZeroGPU is designed for GPU-decorated Gradio functions and is not a suitable runtime for this Node/Playwright app.
