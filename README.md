# MTG Timer

A browser-based application for tracking player time during Magic: The Gathering games. The server maintains authoritative time state to ensure accuracy and prevent disputes. Supports multiplayer formats (2-8 players) common in Commander/EDH and other MTG variants.

## Features

- **Server-Authoritative Time Tracking**: Ensures accuracy across all connected clients
- **Multiplayer Support**: 2-8 players with real-time synchronization
- **Shareable Game Sessions**: Unique game codes allow players to join from different devices
- **Game Controls**: Start, pause, resume, reset functionality
- **Player Switching**: Click or keyboard shortcuts to switch active player
- **Time Adjustments**: Add or subtract time from any player during the game
- **Audio Notifications**: Warning sounds at configurable thresholds and timeout alerts
- **Penalty System**: Configurable penalties on timeout (warning, time deduction, or game loss)
- **Visual States**: Active, warning, critical, timeout, and eliminated states with distinct styling

## Installation

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn

### Setup

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

## Running the Application

### Development

Start the server with default settings (port 3000):
```bash
npm start
```

Specify a custom port:
```bash
PORT=8080 npm start
```

Open your browser and navigate to:
- http://localhost:3000 (default)
- http://localhost:8080 (if using custom port)

### Production

For production deployment, consider:
- Using a reverse proxy (nginx, Apache)
- Enabling HTTPS with a valid SSL certificate
- Setting `NODE_ENV=production`
- Configuring process manager (PM2, systemd)

## Configuration

### Environment Variables

- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment mode (development/production)

### Game Settings

When creating a game, you can configure:
- **Number of Players**: 2-8 players
- **Starting Time**: Time per player in minutes (default: 30)
- **Penalty Type**: What happens on timeout
  - `warning` - Warning only
  - `time_deduction` - Deduct time from next round
  - `game_loss` - Eliminate the player
- **Deduction Amount**: Minutes to deduct (if using time deduction penalty)

## Keyboard Shortcuts

- `Space` - Pass to next player (cycle through players)
- `1-8` - Switch to specific player
- `P` - Pause/Resume game
- `M` - Mute/Unmute audio

## WebSocket API

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `create` | `{ settings }` | Create new game |
| `join` | `{ gameId }` | Join existing game |
| `start` | `{ }` | Start the game |
| `pause` | `{ }` | Toggle pause state |
| `reset` | `{ }` | Reset game to initial state |
| `switch` | `{ playerId }` | Switch active player |
| `updatePlayer` | `{ playerId, name?, time? }` | Edit player name or time |
| `addPenalty` | `{ playerId }` | Add penalty to player |
| `eliminate` | `{ playerId }` | Remove player from game |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `state` | `GameSession` | Full game state |
| `tick` | `{ times: {} }` | Time updates |
| `timeout` | `{ playerId }` | Player timed out |
| `warning` | `{ playerId, threshold }` | Time warning |
| `error` | `{ message }` | Error message |

## Security

- Input validation on all server endpoints
- Player name sanitization to prevent XSS
- Automatic session cleanup after 24 hours of inactivity
- Grace period for empty games (5 minutes)

## Contributing

This project follows the MIT license. Feel free to submit issues and pull requests.

## License

See LICENSE file for details.
