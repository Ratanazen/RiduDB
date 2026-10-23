# RiduDB Studio

**RiduDB Studio** is a native desktop database management application designed for developers working with **PostgreSQL**, **MySQL**, and **SQLite**. Built with Electron, TypeScript, and modern web technologies, RiduDB Studio provides a unified, lightweight, and responsive interface for database inspection and query execution.

---

## Features

- **Multi-Engine Support**:
  - **SQLite**: In-memory and file-based databases powered by `sql.js` (WebAssembly) and native drivers.
  - **PostgreSQL**: Connect and inspect Postgres instances with connection pooling and schema browsing.
  - **MySQL**: Native MySQL database management via `mysql2`.
- **Schema & Table Inspection**:
  - Browse tables, views, and schemas seamlessly.
  - Inspect column definitions, data types, constraints, and default values.
- **Read-Only Query Engine**:
  - Safe query execution with automatic limit bounding.
  - Read-only protection preventing accidental destructive operations.
  - Column metadata and execution timing display.
- **Connection Profile Manager**:
  - Save and organize connection profiles with validation.
  - Memory-safe credential handling.

---

## Tech Stack

- **Framework**: Electron (v30+)
- **Language**: TypeScript / Node.js
- **Frontend / Renderer**: Modern HTML5 / CSS3 / Vanilla TypeScript
- **Database Drivers**:
  - `sql.js` & `better-sqlite3`
  - `pg`
  - `mysql2`
- **Testing**: Jest & `ts-jest`
- **Packaging**: `electron-builder`

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- `npm` or `yarn`

### Installation

```bash
# Clone the repository
git clone https://github.com/Ratanazen/RiduDB.git
cd RiduDB

# Install dependencies
npm install
```

### Development

```bash
# Compile TypeScript (Main and Preload)
npm run tsc

# Compile Renderer
npm run tsc:renderer

# Launch the Electron app
npm run electron:dev
```

### Testing

```bash
# Run unit and integration tests
npm test
```

### Building & Packaging

```bash
# Build distribution packages for Linux / Windows
npm run electron:build
```

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
