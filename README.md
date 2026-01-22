# Tap or Tarp

A browser-based application for tracking player time during Magic: The Gathering games. The server maintains authoritative time state to ensure accuracy and prevent disputes. Supports multiplayer formats (2-8 players) common in Commander/EDH and other MTG variants.

## Features

- **Server-Authoritative Time Tracking**: Ensures accuracy across all connected clients
- **Multiplayer Support**: 2-8 players with real-time synchronization
- **Shareable Game Sessions**: Unique game codes allow players to join from different devices
- **Player Claiming & Reconnection**: Players can claim slots with secure reconnection tokens
- **Game Controls**: Start, pause, resume, reset functionality
- **Player Switching**: Click or keyboard shortcuts to switch active player
- **Time Adjustments**: Add or subtract time from any player during the game
- **Audio Notifications**: Warning sounds at configurable thresholds and timeout alerts
- **Penalty System**: Configurable penalties on timeout (warning, time deduction, or game loss)
- **Visual States**: Active, warning, critical, timeout, and eliminated states with distinct styling
- **Persistent Storage**: SQLite or Redis-backed session persistence
- **Horizontal Scaling**: Cluster mode and Redis-primary mode for multi-instance deployments
- **Prometheus Metrics**: Built-in metrics endpoint for monitoring
- **Graceful Shutdown**: Connection draining with client notification

## Installation

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn

### Setup

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

## Running the Application

### Development

Start the server with pretty-printed logs:

```bash
npm run dev
```

Start with raw JSON logs:

```bash
npm run dev:raw
```

### Production

Start the server (single instance):

```bash
npm start
```

Start in cluster mode (multi-core):

```bash
npm run start:cluster
```

Open your browser and navigate to:

- http://localhost:3000 (default)

### Production Deployment

For production deployment, consider:

- Using a reverse proxy (nginx, Apache)
- Enabling HTTPS with a valid SSL certificate
- Setting `NODE_ENV=production`
- Configuring process manager (PM2, systemd)
- Using Redis for session persistence in multi-instance setups
- Setting `ALLOWED_ORIGINS` to restrict WebSocket connections

## Configuration

### Environment Variables

| Variable          | Default              | Description                                       |
| ----------------- | -------------------- | ------------------------------------------------- |
| `PORT`            | `3000`               | Server port                                       |
| `NODE_ENV`        | `development`        | Environment mode                                  |
| `STORAGE_TYPE`    | `sqlite`             | Storage backend (`sqlite`, `memory`, `redis`)     |
| `DB_PATH`         | `./data/sessions.db` | SQLite database file path                         |
| `REDIS_URL`       | `null`               | Redis connection URL                              |
| `REDIS_PRIMARY`   | `false`              | Use Redis as primary store (for clustering)       |
| `ALLOWED_ORIGINS` | `null`               | Comma-separated list of allowed WebSocket origins |
| `SENTRY_DSN`      | `null`               | Sentry DSN for error tracking                     |
| `WORKERS`         | CPU count            | Number of cluster workers (cluster mode only)     |

### Game Settings

When creating a game, you can configure:

- **Number of Players**: 2-8 players
- **Starting Time**: Time per player in minutes (default: 10)
- **Penalty Type**: What happens on timeout
  - `warning` - Warning only
  - `time_deduction` - Deduct time from next round
  - `game_loss` - Eliminate the player
- **Deduction Amount**: Minutes to deduct (if using time deduction penalty)
- **Warning Thresholds**: Configurable time thresholds for warnings (default: 5min, 1min, 30sec)

## Keyboard Shortcuts

- `Space` - Pass to next player (cycle through players)
- `1-8` - Switch to specific player
- `P` - Pause/Resume game
- `M` - Mute/Unmute audio

## API Endpoints

### HTTP

| Endpoint       | Description                     |
| -------------- | ------------------------------- |
| `GET /`        | Serve the web application       |
| `GET /health`  | Health check with server status |
| `GET /metrics` | Prometheus metrics              |

### WebSocket API

#### Client → Server

| Event            | Payload                       | Description                 |
| ---------------- | ----------------------------- | --------------------------- |
| `create`         | `{ settings }`                | Create new game             |
| `join`           | `{ gameId }`                  | Join existing game          |
| `start`          | `{ }`                         | Start the game              |
| `pause`          | `{ }`                         | Toggle pause state          |
| `reset`          | `{ }`                         | Reset game to initial state |
| `switch`         | `{ playerId }`                | Switch active player        |
| `updatePlayer`   | `{ playerId, name?, time? }`  | Edit player name or time    |
| `updateSettings` | `{ warningThresholds? }`      | Update game settings        |
| `addPenalty`     | `{ playerId }`                | Add penalty to player       |
| `eliminate`      | `{ playerId }`                | Remove player from game     |
| `claim`          | `{ playerId }`                | Claim a player slot         |
| `unclaim`        | `{ }`                         | Release claimed player      |
| `reconnect`      | `{ gameId, playerId, token }` | Reconnect with token        |

#### Server → Client

| Event              | Payload                       | Description                 |
| ------------------ | ----------------------------- | --------------------------- |
| `clientId`         | `{ clientId }`                | Client identifier           |
| `state`            | `GameSession`                 | Full game state             |
| `tick`             | `{ times: {} }`               | Time updates                |
| `timeout`          | `{ playerId }`                | Player timed out            |
| `warning`          | `{ playerId, threshold }`     | Time warning                |
| `claimed`          | `{ playerId, token, gameId }` | Player claimed successfully |
| `reconnected`      | `{ playerId, token, gameId }` | Reconnection successful     |
| `shutdown_warning` | `{ message, timeout }`        | Server shutting down        |
| `error`            | `{ message }`                 | Error message               |

## Security

- **Content Security Policy**: Strict CSP headers to prevent XSS
- **WebSocket Origin Validation**: Configurable allowed origins
- **Input Validation**: Server-side validation on all endpoints
- **Player Name Sanitization**: Prevents XSS in player names
- **Rate Limiting**: IP-based rate limiting for connections (20/min) and messages (30/sec)
- **Automatic Session Cleanup**: Sessions removed after 24 hours of inactivity
- **Grace Period**: Empty games cleaned up after 5 minutes
- **Secure Reconnection Tokens**: 32-byte cryptographic tokens with 1-hour expiry

## Development

### Scripts

```bash
npm run dev          # Start with pretty logs
npm run dev:raw      # Start with JSON logs
npm run lint         # Run ESLint
npm run format       # Format code with Prettier
npm test             # Run tests
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with coverage
```

### Project Structure

```
├── server.js           # Main server entry point
├── cluster.js          # Cluster mode manager
├── lib/
│   ├── game-logic.js   # Core game logic
│   ├── storage.js      # Storage abstraction
│   ├── redis-storage.js # Redis storage implementation
│   ├── game-state-adapter.js # Game state adapter
│   ├── rate-limiter.js # Rate limiting
│   ├── metrics.js      # Prometheus metrics
│   ├── logger.js       # Pino logger
│   └── lock.js         # Async locking
├── public/
│   ├── index.html      # Web UI
│   ├── client.js       # Client-side logic
│   └── style.css       # Styles
└── __tests__/          # Test files
```

## Monitoring

### Health Check

The `/health` endpoint returns:

```json
{
  "status": "healthy",
  "timestamp": "2025-01-22T12:00:00.000Z",
  "uptime": 3600,
  "instanceId": "instance_abc123",
  "activeSessions": 5,
  "activeConnections": 12,
  "storageType": "sqlite",
  "persistedSessions": 10,
  "locks": { "pending": 0, "acquired": 0 },
  "rateLimiter": { ... }
}
```

### Prometheus Metrics

Available at `/metrics`, includes:

- `tapotarp_websocket_connections_total` - Active WebSocket connections
- `tapotarp_game_sessions_active` - Active game sessions
- `tapotarp_websocket_messages_received_total` - Messages by type
- `tapotarp_storage_save_duration_seconds` - Storage operation latency
- `tapotarp_errors_total` - Errors by type
- `tapotarp_rate_limit_exceeded_total` - Rate limit events
- Default Node.js metrics (CPU, memory, event loop, etc.)

## Contributing

This project follows the MIT license. Feel free to submit issues and pull requests.

## License

See LICENSE file for details.
