# AshkanBoard
### Enterprise Project Management & Team Collaboration Platform

**AshkanBoard** is a modern project management and team collaboration platform designed to help teams organize projects, manage tasks, track issues, coordinate workflows, and collaborate through a centralized workspace.

Built with React, Node.js, and PostgreSQL-oriented persistence architecture, AshkanBoard combines project planning, task management, team collaboration, enterprise security, and operational capabilities in one extensible application.

The platform supports Persian and English interfaces, including RTL and LTR layouts.

---

## Overview

AshkanBoard is designed to provide a structured environment for managing projects and coordinating team activities.

Rather than focusing exclusively on basic task management, the platform brings together multiple aspects of project operations:

- Project and workspace management
- Task and issue tracking
- Team collaboration
- Access control and permissions
- Notifications and activity tracking
- File and attachment management
- Security and authentication
- Data management and operational tooling

The goal is to create a maintainable, extensible foundation for modern team productivity.

## Core Features

### 1. Workspace Management
- Create and manage multiple workspaces.
- Workspace-scoped data and operations.
- Member management.
- Role-based permissions.
- Workspace invitations.
- Workspace isolation and access enforcement.

### 2. Task & Issue Management
- Create, edit, and delete tasks.
- Manage task status and priorities.
- Track due dates and assignments.
- Manage projects, tags, and dependencies.
- Estimates and time tracking.
- Recurring tasks.
- Bulk status updates.
- Search and filtering.

### 3. Project Planning
- Multiple board views.
- Planning and scheduling workflows.
- Milestones and project organization.
- Saved views and filtering.
- QA Gate and testing-related workflows.

### 4. Team Collaboration
- Ticket discussion threads.
- Comments and user mentions.
- Member activity notifications.
- Online presence indicators.
- Server-Sent Events (SSE) for live updates.
- File attachments and document previews.

### 5. Authentication & Security
- User registration and authentication.
- Access-token management.
- Refresh-token rotation.
- Session revocation and replay detection.
- Password reset workflows.
- Workspace-level authorization.
- Multi-Factor Authentication (MFA).
- OpenID Connect (OIDC) integration.
- SCIM 2.0 provisioning capabilities.
- Server-side audit logging.

### 6. Notifications & Data Management
- Workspace-scoped notification inbox.
- Unread notification tracking.
- Read and read-all operations.
- Safe ticket import with dry-run validation.
- Idempotent import operations.
- Data integrity and migration tooling.

### 7. Enterprise Infrastructure
- PostgreSQL persistence.
- Normalized relational data model.
- Database migration tooling.
- Redis-compatible caching architecture.
- API health and readiness endpoints.
- Structured application logging.
- Docker-based deployment configuration.
- Backup and restore operations.
- Automated CI/CD workflows.

### 8. Internationalization
- Persian language support.
- English language support.
- Right-to-Left (RTL) layout.
- Left-to-Right (LTR) layout.
- Language-aware interface rendering.

---

## Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React 19 |
| Build Tool | Vite 8 |
| Styling | Tailwind CSS 4 |
| Backend | Node.js |
| API | RESTful API |
| Database | PostgreSQL |
| Data Access | Modular persistence and repository architecture |
| Caching | Redis-compatible caching |
| Real-time Communication | Server-Sent Events (SSE) |
| Authentication | Token-based authentication |
| Enterprise Identity | OIDC / SCIM 2.0 |
| Testing | Node.js Test Runner / Playwright |
| CI/CD | GitHub Actions |
| Deployment | Docker / Docker Compose |

---

## Architecture

AshkanBoard follows a modular architecture with separate frontend, backend, persistence, and operational responsibilities.

```text
AshkanBoard
│
├── src/
│   ├── api/
│   ├── components/
│   ├── features/
│   ├── pages/
│   └── ...
│
├── server/
│   ├── app.mjs
│   ├── tests/
│   ├── migrations/
│   ├── repositories/
│   └── ops/
│
├── e2e/
│
├── scripts/
│
├── data/
│
├── .github/
│   └── workflows/
│
├── package.json
└── vite.config.js
```

*Note: The directory structure above is a conceptual overview of the main application areas.*

---

## Getting Started

### Prerequisites

- Node.js 20 or newer.
- npm.
- PostgreSQL for database-backed deployments.
- Redis (optional, for distributed caching).
- Git.

### 1. Clone the Repository

```bash
git clone https://github.com/YourUsername/ashkan-board.git
cd ashkan-board
```

### 2. Install Dependencies

```bash
npm ci
```

### 3. Configure Environment Variables

Copy the example environment file:

**Windows CMD:**

```cmd
copy .env.example .env
```

**Linux / macOS:**

```bash
cp .env.example .env
```

Configure the required variables, especially:

```env
PORT=4000
JWT_SECRET=your-unique-secret-of-at-least-32-characters
CORS_ORIGIN=http://localhost:5173
DATABASE_URL=postgresql://username:password@localhost:5432/ashkan_board
NODE_ENV=development
```

Use a unique, securely generated secret. Never commit `.env` or production credentials.

### 4. Start the Application

Run the development environment:

```bash
npm run dev
```

The development launcher manages the application startup.

Alternatively, run the API and frontend separately:

**Terminal 1 — Backend:**

```bash
npm run api
```

**Terminal 2 — Frontend:**

```bash
npm run dev:client
```

Open:

```text
http://localhost:5173
```

### 5. Database Migrations

After configuring PostgreSQL and installing the optional PostgreSQL driver:

```bash
npm install pg
npm run db:migrate
```

The project also provides database verification, backup, restore, integrity, and migration-audit scripts.

---

## Testing & Quality Assurance

AshkanBoard includes automated testing infrastructure.

### API Integration Tests

```bash
npm run test:api
```

### End-to-End Tests

```bash
npm run test:e2e
```

### Security Tests

```bash
npm run security:test
```

### Linting

```bash
npm run lint
```

### Production Build

```bash
npm run build
```

Additional database and performance diagnostics are available through the npm scripts.

---

## Engineering Principles

The project emphasizes:

- Clean Code and separation of concerns.
- Modular application architecture.
- Reusable components.
- Server-side authorization.
- Workspace data isolation.
- Secure configuration management.
- Database migration discipline.
- Automated testing.
- Maintainability and extensibility.
- Responsive and accessible user interfaces.

---

## Security & Production Considerations

AshkanBoard includes several security and operational foundations, but deployment readiness must be evaluated against the actual infrastructure and configuration.

Before production deployment, particular attention should be given to:

- Secure, HttpOnly cookie-based session handling.
- CSRF and XSS protection.
- Email verification and recovery workflows.
- Production identity-provider configuration.
- Private object storage and attachment scanning.
- Distributed event and presence infrastructure.
- Database backup and disaster recovery.
- Monitoring, alerting, and deployment security.

---

## Development Status

AshkanBoard is under active incremental development.

The current repository package version identifies the development milestone as Phase 76.

Development focuses on expanding enterprise capabilities, strengthening the persistence architecture, improving security, and enhancing application reliability.

---

## Future Roadmap

Potential areas for continued development include:

- Advanced project analytics and reporting.
- Enterprise workflow automation.
- Extended integrations.
- Advanced resource planning.
- AI-assisted project management.
- Enhanced observability.
- Additional collaboration capabilities.

---

## Author

**Ashkan Mataei**

Software Developer | Full-Stack Development | Software Engineering

Interested in building scalable applications, enterprise software, project management platforms, and modern web technologies.

---

## License

This project is currently maintained as a personal software development project.

A formal license will be added when the distribution and usage terms are defined.

---

**AshkanBoard — Plan better. Collaborate smarter. Deliver more.**
