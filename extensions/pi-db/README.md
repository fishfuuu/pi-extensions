# pi-db

Pi-native MySQL/MariaDB read-only agent tool.

## What is pi-db?

pi-db is a Pi extension that enables AI agents to query MySQL/MariaDB databases directly for data verification, investigation, and analysis. Agents can generate read-only SQL queries and receive results in their context without requiring users to write manual database commands.

## Why?

- Agents can directly query databases for fact-checking and data analysis
- No need for users to write Python scripts or manual SQL commands
- Built-in safety: read-only by default, project-level authorization required
- Designed for investigative queries, not production data modification

## Key Features

- **Read-only by default**: SQL validation layer blocks writes (INSERT/UPDATE/DELETE/etc.)
- **Project-scoped authorization**: Installation ≠ authorization; each project must explicitly opt-in
- **Disabled by default**: No automatic database access; requires project configuration
- **Config contains no secrets**: Credentials remain in existing `.env` files
- **Safety boundaries**:
  - Multi-statement rejection
  - `INTO OUTFILE`/`DUMPFILE` blocked
  - `LOAD_FILE()` blocked
  - Executable MySQL comments blocked
  - `SET SESSION TRANSACTION READ ONLY`
  - 20s query timeout
  - LIMIT 200 rows
  - 32KB result cap

**Security note:** The SQL read-only guard is a defense-in-depth layer, not a database permission boundary. For production use, prefer a dedicated database account with SELECT-only privileges and no FILE privilege.

## Installation

### Global Installation

Install the extension in your Pi agent extensions directory:

```bash
# Copy pi-db to global extensions
cp -r pi-db ~/.pi/agent/extensions/
```

### Project-Local Installation

For project-specific installation:

```bash
# Copy pi-db to project extensions
cp -r pi-db <your-project>/.pi/extensions/
```

**Important:** Extension installation alone does NOT grant database access. See Authorization below.

## Authorization

**Installation ≠ Authorization**

To enable pi-db for a specific project, create a configuration file:

```bash
# In your project root
mkdir -p .pi
```

Create `.pi/pi-db.json`:

```json
{
  "enabled": true,
  "envFile": ".env",
  "envPrefix": "DB_"
}
```

Without this file (or with `"enabled": false`), db_query will fail-closed with "db_query disabled in this project".

## Configuration

### `.pi/pi-db.json` Fields

- **`enabled`** (boolean, required): Set to `true` to authorize database access for this project
- **`envFile`** (string, required): Relative path from project root to the `.env` file containing database credentials
- **`envPrefix`** (string, required): Environment variable prefix for database credentials (must match `/^[A-Z][A-Z0-9_]*$/`)

**Security:**
- Config file contains no secrets - credentials stay in `.env`
- `envFile` must be relative and within project directory (no `../` escapes)
- `envPrefix` is validated (uppercase letters, digits, underscores only)

### `.env` File

Create a `.env` file with your database credentials (see `examples/env.example`):

```bash
DB_HOST=your-database-host
DB_PORT=3306
DB_USER=your-db-user
DB_PASSWORD=your-db-password
DB_NAME=your-database-name
```

**Important:**
- Never commit `.env` files containing real credentials
- Add `.env` to your `.gitignore`
- Use the `envPrefix` value from `pi-db.json` (e.g., `DB_`, `MYAPP_DB_`)

## Database Account

### Recommended: Dedicated Read-Only Account

For production environments, create a dedicated MySQL user with minimum privileges:

```sql
CREATE USER 'agent_reader'@'client-host' IDENTIFIED BY 'strong-random-password';
GRANT SELECT ON `your_database`.* TO 'agent_reader'@'client-host';
```

See `examples/mysql-readonly-user.sql.example` for a complete template.

**Why?**
- Database-level enforcement: reader physically cannot write
- Defense-in-depth: SQL guard + database permissions
- Reduced blast radius if application bugs bypass SQL validation

**Privileges NOT granted:**
- FILE (file operations)
- INSERT, UPDATE, DELETE (write operations)
- CREATE, DROP, ALTER (DDL operations)
- EXECUTE (stored procedures/functions)
- GRANT OPTION (privilege management)
- Admin privileges (SUPER, PROCESS, SHUTDOWN, etc.)

**SHOW VIEW consideration:**
- SELECT privilege is sufficient for querying views
- SHOW VIEW is only needed for `EXPLAIN` on views or `SHOW CREATE VIEW`
- Grant SHOW VIEW only if you have a confirmed requirement

## Usage

### In Pi Agent Conversations

Ask the agent naturally:

```
Use db_query to count orders for August 2024.
```

Or provide specific SQL:

```
db_query:
SELECT COUNT(*) FROM orders 
WHERE created_at >= '2024-08-01' 
AND created_at < '2024-09-01';
```

The agent will execute read-only queries and use the results in its reasoning.

### Command Line

```bash
# View last query result in current project
/db --last
```

## Security Model

### Multi-Layer Protection

1. **Project Authorization Gate**
   - Installation does not grant access
   - Each project requires explicit `.pi/pi-db.json` opt-in
   - Failed authorization → fail-closed (query rejected)

2. **SQL Validation (Defense-in-Depth)**
   - SELECT/SHOW/DESCRIBE/EXPLAIN/WITH only
   - Multi-statement blocking
   - INTO OUTFILE/DUMPFILE/LOAD_FILE rejection
   - Executable comment blocking
   - Normalized SQL enforcement

3. **Database Session Safety**
   - `SET SESSION TRANSACTION READ ONLY`
   - `multipleStatements: false`
   - Query timeout (20s)
   - Result limits (200 rows, 32KB)

4. **Database-Level Permissions (Recommended)**
   - Dedicated read-only MySQL account
   - SELECT-only privileges
   - No FILE privilege
   - Primary security boundary

### Secrets Handling

- Credentials never stored in `pi-db.json`
- Credentials remain in project `.env` files
- Connection strings not logged
- Error messages sanitized (no password leakage)

## Limitations

- **MySQL/MariaDB only**: PostgreSQL, SQLite, etc. not supported
- **Read-only only**: No INSERT/UPDATE/DELETE/DDL operations
- **No schema browser**: Not a replacement for database admin tools
- **No credential manager**: Uses existing `.env` files
- **No automatic account creation**: Database administrator must create accounts manually
- **EXPLAIN on views**: May require SHOW VIEW privilege depending on view complexity
- **Result bounds**: 200 rows max, 32KB max result size

## Examples

See the `examples/` directory:
- `pi-db.json` - Project configuration template
- `env.example` - Environment variables template
- `mysql-readonly-user.sql.example` - Database account setup guide

## Testing

Run tests:

```bash
npm test
```

Or individually:

```bash
npm run test:sql   # SQL validation tests
npm run test:gate  # Project authorization tests
```

## License

See LICENSE file (to be determined - license selection pending).

## Support

This is an open-source Pi extension. For issues or contributions, please refer to the project repository.
