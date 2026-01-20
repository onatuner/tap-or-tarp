# Deploying Tap or Tarp to Fly.io

## Deployment Options

1. **GitHub Actions (Recommended)** - Automatic deployment on push to main
2. **Manual CLI** - Deploy from your local machine

---

## Option 1: GitHub Actions (Automated)

### Initial Setup (One-Time)

1. **Create a Fly.io account and app**:
   ```bash
   # Install Fly CLI
   # Windows (PowerShell)
   pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
   # macOS/Linux
   curl -L https://fly.io/install.sh | sh

   # Login and create app
   fly auth login
   fly apps create tap-or-tarp
   ```

2. **Get your Fly.io API token**:
   ```bash
   fly tokens create deploy -x 999999h
   ```
   Copy the token that starts with `FlyV1 ...`

3. **Add the token to GitHub**:
   - Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
   - Click **New repository secret**
   - Name: `FLY_API_TOKEN`
   - Value: Paste your token

4. **Push to GitHub**:
   ```bash
   git add .
   git commit -m "Add deployment configuration"
   git push origin main
   ```

### How It Works

| Trigger | Workflow | Action |
|---------|----------|--------|
| Push to `main` | `deploy.yml` | Deploy to Fly.io |
| Pull request | `ci.yml` | Run checks (syntax, Docker build) |
| Manual | `deploy.yml` | Trigger from Actions tab |

### Manual Trigger

1. Go to **Actions** tab in GitHub
2. Select **Deploy** workflow
3. Click **Run workflow**

---

## Option 2: Manual CLI Deployment

### Prerequisites

1. Install the Fly.io CLI:
   ```bash
   # Windows (PowerShell)
   pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"

   # macOS/Linux
   curl -L https://fly.io/install.sh | sh
   ```

2. Sign up and authenticate:
   ```bash
   fly auth signup
   # or if you have an account:
   fly auth login
   ```

### First-Time Deployment

1. **Create the app on Fly.io**:
   ```bash
   fly apps create tap-or-tarp
   ```

2. **Deploy**:
   ```bash
   fly deploy
   ```

3. **Open your app**:
   ```bash
   fly open
   ```

Your app will be available at `https://tap-or-tarp.fly.dev`

### Subsequent Deployments

Just run:
```bash
fly deploy
```

---

## Useful Commands

| Command | Description |
|---------|-------------|
| `fly status` | Check app status and running machines |
| `fly logs` | View application logs |
| `fly logs -f` | View logs in real-time |
| `fly ssh console` | SSH into a running machine |
| `fly scale count 2` | Scale to 2 instances |
| `fly scale memory 512` | Increase memory to 512MB |
| `fly regions add ams` | Add Amsterdam region |
| `fly secrets set KEY=value` | Set environment variables |
| `fly dashboard` | Open Fly.io dashboard |

---

## Scaling for High Traffic

### Add More Regions (Lower Latency)
```bash
# Add European and Asian regions
fly regions add ams sin

# Scale to 2 machines per region
fly scale count 2 --region iad,ams,sin
```

### Increase Resources
```bash
# More memory
fly scale memory 512

# Dedicated CPU
fly scale vm dedicated-cpu-1x
```

---

## Environment Variables

Set secrets (like API keys) using:
```bash
fly secrets set MY_SECRET=value
```

View current secrets:
```bash
fly secrets list
```

---

## Troubleshooting

### App not starting
```bash
# Check logs
fly logs

# Check machine status
fly status

# SSH into machine to debug
fly ssh console
```

### WebSocket connection issues
- Ensure you're using `wss://` (not `ws://`) in production
- The client.js already handles this automatically

### Health check failing
```bash
# Test health endpoint
curl https://tap-or-tarp.fly.dev/health
```

### GitHub Actions failing
- Check that `FLY_API_TOKEN` secret is set correctly
- Verify token hasn't expired: `fly tokens list`
- Check Actions tab for detailed error logs

---

## Cost Estimate

Fly.io pricing (as of 2024):
- **Free tier**: 3 shared-cpu-1x VMs with 256MB RAM
- **Beyond free tier**: ~$2/month per 256MB shared-cpu-1x VM

For a typical Tap or Tarp deployment:
- 1 VM in 1 region: Free
- 2 VMs in 2 regions: ~$2/month
- 3 VMs in 3 regions: ~$4/month

---

## Production Checklist

### Initial Setup
- [ ] Create Fly.io account
- [ ] Create app: `fly apps create tap-or-tarp`
- [ ] Generate deploy token: `fly tokens create deploy -x 999999h`
- [ ] Add `FLY_API_TOKEN` to GitHub secrets
- [ ] Push to main branch

### Verify Deployment
- [ ] Check GitHub Actions completed successfully
- [ ] Verify health check: `curl https://tap-or-tarp.fly.dev/health`
- [ ] Test WebSocket connection in browser
- [ ] Create a test game session

### Optional Enhancements
- [ ] Add additional regions for lower latency
- [ ] Set up monitoring/alerts in Fly.io dashboard
- [ ] Configure custom domain (if desired)
