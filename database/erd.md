# Database ER diagram

Renders on GitHub (Mermaid). Source of truth for types and indexes: `backend/prisma/schema.prisma`.
To export a PNG/PDF: paste the block into https://mermaid.live or dbdiagram.io and save as `docs/database-erd.png`.

```mermaid
erDiagram
  organizations ||--o{ tenants : "has branches"
  organizations ||--o{ memberships : ""
  tenants ||--o{ memberships : "tenant_id (NULL = org-level)"
  users ||--o{ memberships : ""
  organizations ||--o{ boards : ""
  tenants ||--o{ boards : "tenant_id"
  boards ||--o{ columns : ""
  tenants ||--o{ columns : "tenant_id"
  columns ||--o{ tasks : ""
  boards ||--o{ tasks : ""
  tenants ||--o{ tasks : "tenant_id"
  users |o--o{ tasks : "assigned_to / created_by"
  tenants ||--o{ activity_logs : "tenant_id"
  users |o--o{ activity_logs : "user_id"

  organizations { uuid id PK
    varchar name
    timestamp created_at
    timestamp updated_at }
  tenants { uuid id PK
    uuid organization_id FK
    varchar name "UNIQUE per organization"
    timestamp created_at }
  users { uuid id PK
    varchar name
    varchar email "UNIQUE"
    text password_hash "bcrypt"
    timestamp created_at }
  memberships { uuid id PK
    uuid user_id FK
    uuid organization_id FK
    uuid tenant_id FK "nullable"
    enum role "ORG_ADMIN | TENANT_ADMIN | MEMBER"
    timestamp created_at }
  boards { uuid id PK
    uuid organization_id FK
    uuid tenant_id FK
    varchar name
    text description
    uuid created_by FK
    timestamp created_at }
  columns { uuid id PK
    uuid board_id FK
    uuid tenant_id FK
    varchar name
    int position }
  tasks { uuid id PK
    uuid board_id FK
    uuid column_id FK
    uuid tenant_id FK
    varchar title
    text description
    uuid assigned_to FK
    uuid created_by FK
    enum priority
    timestamp due_date
    float position "fractional rank"
    int version "optimistic lock"
    timestamp created_at
    timestamp updated_at }
  activity_logs { uuid id PK
    uuid tenant_id FK
    uuid user_id FK
    varchar entity_type
    uuid entity_id
    varchar action
    jsonb details
    timestamp created_at }
```

## Indexes

| Table | Index | Serves |
|---|---|---|
| tenants | `(organization_id)`, unique `(organization_id, name)` | listing branches of an org |
| memberships | `(user_id)`, `(tenant_id)`, `(organization_id)`, unique `(user_id, organization_id, tenant_id)` | every authorization lookup |
| boards | `(tenant_id)` | board list |
| columns | `(board_id)`, `(tenant_id)` | board load |
| tasks | `(tenant_id, board_id)`, `(tenant_id, column_id, position)` | board load and neighbour lookup when moving a card |
| activity_logs | `(tenant_id, created_at)`, `(tenant_id, entity_id)` | tenant feed, per-task history |
