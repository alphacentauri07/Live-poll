# PulseVote – Live Polling App

A minimal live polling system with real-time teacher-hosted questions and student participation.

## Project Structure

- `frontend/` – React (Vite) client
- `backend/` – Node.js/Express + Socket.IO server

## Requirements

- Node.js 18+
- npm 9+

## Quick Start

1) Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
```

2) Run the server

```bash
cd backend
npm start
```

3) Run the client

```bash
cd frontend
npm run dev
```

Open the printed localhost URL (default Vite port) in your browser.

## Configuration

Backend:
- `PORT` (default: `4000`)
- `CLIENT_ORIGIN` (default: `*`)

Frontend:
- Create `frontend/.env` (optional):

```bash
VITE_SERVER_URL=http://localhost:4000
```

## Features

- Teacher creates and asks timed multiple-choice questions
- Students join and submit answers in real time
- Live aggregated results for the teacher
- Simple chat between teacher and students
- Kick student (teacher only)

## Scripts

Backend (`backend/package.json`):
- `npm start` – start server
- `npm run dev` – same as start

Frontend (`frontend/package.json`):
- `npm run dev` – start Vite dev server
- `npm run build` – production build
- `npm run preview` – preview build

## Notes

- All socket event names and payload shapes are stable; only internal variable names were refactored for clarity.
- Folders were renamed to `frontend` and `backend`. If your editor had old paths open, re-open files from the new folders.


