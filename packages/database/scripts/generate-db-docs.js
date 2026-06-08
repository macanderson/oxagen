#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(__dirname, "../src/schema");

// Schema metadata
const SCHEMA_DESCRIPTIONS = {
  auth: "Authentication, sessions, API keys, and user preferences. Managed by Better Auth.",
  org: "Organizations and workspace membership. Defines billing entities and team boundaries.",
  workspace: "Workspaces and workspace-scoped configuration. Teams work within workspaces.",
  integration: "External service integrations and connection management.",
  agent: "Agent runtime, skills, background tasks, and approval workflows.",
  workflow: "Workflow definitions and metadata. Execution events flow to ClickHouse.",
  event: "Event definitions and schema metadata. Events flow to ClickHouse.",
  execution: "Execution metadata for agents and workflows. Event details in ClickHouse.",
  chat: "Conversations, messages, and chat history. Multi-tenant, workspace-scoped.",
  content: "Generated content, media assets, and workspace documents.",
  graph: "Knowledge graph entities and relationships (Neo4j-backed).",
  evaluation: "Evaluation and assessment data for LLM outputs and agent performance.",
  billing: "Billing, subscriptions, invoices, and credit tracking. Stripe-synced.",
  security: "Security policies, audit logs, and compliance tracking.",
  mcp: "MCP server integrations and marketplace configuration.",
  plugin: "Plugin marketplace, installations, and versioning.",
  notification: "Notifications and notification preferences.",
};

const SCHEMA_CONVENTIONS = {
  auth: "Better Auth schema. Text PKs for sessions/accounts/verifications per framework.",
  org: "Org-scoped resources include orgId. Invitations are org-level, not workspace-scoped.",
  workspace: "All workspace-scoped resources include workspaceId.",
  agent: "Skill versions are immutable. Background tasks are async job tracking.",
  billing: "Credit-based, no FX. Stripe syncs via Inngest.",
  chat: "Conversations are workspace-scoped. Messages reference execution outputs.",
};

// Parse schema files to extract table information
function parseSchemaFiles() {
  const schemas = {};

  const files = fs
    .readdirSync(schemaDir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"));

  for (const file of files) {
    const schemaName = file.replace(".ts", "");
    const filePath = path.join(schemaDir, file);
    const content = fs.readFileSync(filePath, "utf-8");

    schemas[schemaName] = {
      name: schemaName,
      description: SCHEMA_DESCRIPTIONS[schemaName] || "",
      convention: SCHEMA_CONVENTIONS[schemaName] || "",
      tables: [],
      content, // Keep for advanced parsing
    };

    // Extract table definitions with basic regex
    const tableRegex =
      /export const (\w+)\s*=\s*(\w+Schema)\.table\s*\(\s*["'](\w+)["']/g;
    let match;

    while ((match = tableRegex.exec(content)) !== null) {
      const [, varName, schemaVar, tableName] = match;
      schemas[schemaName].tables.push({
        name: tableName,
        varName,
        schema: schemaName,
        columns: [],
        usage: extractTableComment(content, varName),
      });
    }
  }

  return schemas;
}

// Extract usage/description comment for a table
function extractTableComment(content, tableName) {
  // Look for comments before the table export
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`export const ${tableName}`)) {
      // Look backwards for comments
      let comment = "";
      for (let j = i - 1; j >= 0 && j > i - 10; j--) {
        const line = lines[j].trim();
        if (line.startsWith("//")) {
          comment = line.replace(/^\/\/\s*/, "") + " " + comment;
        } else if (line === "" || line.startsWith("*")) {
          continue;
        } else {
          break;
        }
      }
      return comment.trim();
    }
  }
  return "";
}

// Generate HTML documentation
function generateHTML(schemas) {
  const schemaList = Object.values(schemas);
  const allTables = schemaList.flatMap((s) => s.tables);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Oxagen Database Schema Reference</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      --primary: #6366f1;
      --primary-light: #818cf8;
      --primary-dark: #4f46e5;
      --gray-50: #f9fafb;
      --gray-100: #f3f4f6;
      --gray-200: #e5e7eb;
      --gray-300: #d1d5db;
      --gray-400: #9ca3af;
      --gray-600: #4b5563;
      --gray-700: #374151;
      --gray-800: #1f2937;
      --gray-900: #111827;
      --success: #10b981;
      --warning: #f59e0b;
      --error: #ef4444;
    }

    html {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--gray-800);
      background: var(--gray-50);
    }

    body {
      line-height: 1.6;
      background: white;
    }

    header {
      background: linear-gradient(135deg, var(--primary-dark), var(--primary));
      color: white;
      padding: 40px;
      text-align: center;
    }

    header h1 {
      font-size: 2.5em;
      margin-bottom: 10px;
    }

    header p {
      font-size: 1.1em;
      opacity: 0.9;
    }

    .container {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 40px;
      padding: 40px;
      max-width: 1600px;
      margin: 0 auto;
    }

    .search-box {
      position: sticky;
      top: 20px;
      z-index: 100;
      background: white;
      padding: 20px;
      border-radius: 8px;
      border: 2px solid var(--gray-200);
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }

    .search-box input {
      width: 100%;
      padding: 12px 16px;
      font-size: 1em;
      border: 1px solid var(--gray-300);
      border-radius: 6px;
      transition: all 0.3s;
    }

    .search-box input:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    }

    .search-results {
      margin-top: 20px;
      max-height: 600px;
      overflow-y: auto;
    }

    .search-result-item {
      padding: 12px;
      margin-bottom: 8px;
      background: var(--gray-50);
      border-left: 3px solid var(--primary);
      cursor: pointer;
      border-radius: 4px;
      transition: all 0.2s;
    }

    .search-result-item:hover {
      background: var(--gray-100);
      transform: translateX(4px);
    }

    .search-result-type {
      font-size: 0.8em;
      color: var(--gray-500);
      text-transform: uppercase;
      font-weight: 600;
    }

    .schemas-nav {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 20px;
      border-bottom: 2px solid var(--gray-200);
      padding-bottom: 20px;
    }

    .schema-btn {
      padding: 8px 16px;
      border: 2px solid var(--gray-300);
      background: white;
      cursor: pointer;
      border-radius: 6px;
      font-weight: 600;
      transition: all 0.2s;
    }

    .schema-btn:hover,
    .schema-btn.active {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
    }

    .main-content {
      position: relative;
    }

    .schema-section {
      display: none;
    }

    .schema-section.active {
      display: block;
      animation: fadeIn 0.3s;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .schema-header {
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 3px solid var(--primary);
    }

    .schema-header h2 {
      font-size: 1.8em;
      margin-bottom: 10px;
      color: var(--primary);
    }

    .schema-header .description {
      color: var(--gray-600);
      font-size: 1.05em;
      margin-bottom: 10px;
    }

    .schema-header .convention {
      background: var(--gray-100);
      padding: 12px;
      border-radius: 6px;
      font-size: 0.95em;
      color: var(--gray-700);
      border-left: 3px solid var(--warning);
    }

    .tables-grid {
      display: grid;
      gap: 20px;
      margin-bottom: 40px;
    }

    .table-card {
      background: white;
      border: 2px solid var(--gray-200);
      border-radius: 8px;
      overflow: hidden;
      transition: all 0.3s;
      cursor: pointer;
    }

    .table-card:hover {
      border-color: var(--primary);
      box-shadow: 0 8px 16px rgba(99, 102, 241, 0.15);
      transform: translateY(-2px);
    }

    .table-card-header {
      background: var(--primary);
      color: white;
      padding: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .table-card-header h3 {
      font-size: 1.2em;
    }

    .table-usage {
      padding: 16px;
      background: var(--gray-50);
      color: var(--gray-700);
      font-size: 0.95em;
      min-height: 40px;
    }

    .table-columns {
      padding: 16px;
      max-height: 300px;
      overflow-y: auto;
      border-top: 1px solid var(--gray-200);
    }

    .column-row {
      padding: 12px;
      border-bottom: 1px solid var(--gray-100);
      font-family: monospace;
      font-size: 0.9em;
    }

    .column-row:last-child {
      border-bottom: none;
    }

    .column-name {
      color: var(--primary);
      font-weight: 600;
      margin-bottom: 4px;
    }

    .column-type {
      color: var(--gray-600);
      font-size: 0.85em;
    }

    .column-flags {
      display: flex;
      gap: 6px;
      margin-top: 4px;
      flex-wrap: wrap;
    }

    .flag {
      display: inline-block;
      padding: 2px 6px;
      background: var(--gray-200);
      color: var(--gray-700);
      border-radius: 3px;
      font-size: 0.75em;
      font-weight: 600;
      text-transform: uppercase;
    }

    .flag.pk {
      background: var(--success);
      color: white;
    }

    .flag.fk {
      background: var(--error);
      color: white;
    }

    .flag.unique {
      background: var(--warning);
      color: white;
    }

    .erd-section {
      margin-top: 60px;
      padding-top: 40px;
      border-top: 3px solid var(--gray-200);
    }

    .erd-section h2 {
      font-size: 1.8em;
      margin-bottom: 30px;
      color: var(--primary);
    }

    .erd-container {
      background: white;
      border: 2px solid var(--gray-200);
      border-radius: 8px;
      padding: 20px;
      overflow-x: auto;
      min-height: 600px;
    }

    .mermaid {
      display: flex;
      justify-content: center;
    }

    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 1000;
      justify-content: center;
      align-items: center;
    }

    .modal.active {
      display: flex;
    }

    .modal-content {
      background: white;
      border-radius: 12px;
      max-width: 900px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
      padding: 40px;
      position: relative;
      animation: slideUp 0.3s;
    }

    @keyframes slideUp {
      from { transform: translateY(50px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .modal-close {
      position: absolute;
      top: 20px;
      right: 20px;
      background: var(--gray-200);
      border: none;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 1.5em;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .modal-close:hover {
      background: var(--gray-300);
    }

    .table-detail h3 {
      font-size: 1.5em;
      margin-bottom: 20px;
      color: var(--primary);
    }

    .columns-detail {
      margin-bottom: 30px;
    }

    .columns-detail h4 {
      font-size: 1.1em;
      margin-bottom: 15px;
      color: var(--gray-700);
    }

    .column-detail {
      background: var(--gray-50);
      padding: 15px;
      margin-bottom: 10px;
      border-radius: 6px;
      border-left: 3px solid var(--primary);
    }

    .column-detail-name {
      font-family: monospace;
      font-weight: 600;
      color: var(--primary);
      margin-bottom: 8px;
    }

    .column-detail-info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      font-size: 0.95em;
      color: var(--gray-700);
    }

    .detail-label {
      font-weight: 600;
      color: var(--gray-600);
    }

    .appendix {
      margin-top: 60px;
      padding-top: 40px;
      border-top: 3px solid var(--gray-200);
    }

    .appendix h2 {
      font-size: 1.8em;
      margin-bottom: 30px;
      color: var(--primary);
    }

    .convention-list {
      display: grid;
      gap: 20px;
    }

    .convention-item {
      background: var(--gray-50);
      padding: 20px;
      border-radius: 8px;
      border-left: 4px solid var(--primary);
    }

    .convention-item h4 {
      font-size: 1.1em;
      margin-bottom: 10px;
      color: var(--primary);
      text-transform: capitalize;
    }

    .convention-item p {
      color: var(--gray-700);
    }

    .no-results {
      text-align: center;
      padding: 40px;
      color: var(--gray-500);
    }

    footer {
      background: var(--gray-100);
      padding: 30px;
      text-align: center;
      color: var(--gray-600);
      margin-top: 60px;
    }

    @media (max-width: 1200px) {
      .container {
        grid-template-columns: 1fr;
      }
    }

    @media print {
      .search-box,
      .schemas-nav {
        display: none;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>Oxagen Database Schema Reference</h1>
    <p>Interactive database documentation with searchable tables, schemas, and relationships</p>
  </header>

  <div class="container">
    <!-- Search sidebar -->
    <aside>
      <div class="search-box">
        <input
          type="text"
          id="searchInput"
          placeholder="Search tables, columns, schemas..."
          autocomplete="off"
        >
        <div class="search-results" id="searchResults"></div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="main-content">
      <div class="schemas-nav" id="schemasNav"></div>

      <div id="schemasContainer"></div>

      <!-- ERD Section -->
      <div class="erd-section">
        <h2>Database Entity Relationship Diagram</h2>
        <div class="erd-container">
          <div class="mermaid" id="erdDiagram"></div>
        </div>
      </div>

      <!-- Appendix -->
      <div class="appendix">
        <h2>Naming Conventions & Standards</h2>
        <div class="convention-list" id="conventionList"></div>
      </div>
    </main>
  </div>

  <!-- Table Detail Modal -->
  <div class="modal" id="tableModal">
    <div class="modal-content">
      <button class="modal-close" onclick="closeTableModal()">&times;</button>
      <div id="tableDetailContent"></div>
    </div>
  </div>

  <footer>
    <p>Generated from Drizzle ORM schema definitions • Last updated ${new Date().toLocaleDateString()}</p>
  </footer>

  <script
    src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"
    integrity="sha384-DO5I13PxDVzV3/+foDrAjVrh1nQV7kqrDMYapI1XrXlBXezoLn1MAzVuQzDeIvDE"
    crossorigin="anonymous"
  ><\/script>
  <script>
    // Utility to safely escape HTML
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Data
    const SCHEMAS = ${JSON.stringify(schemaList)};
    const ALL_TABLES = ${JSON.stringify(allTables)};

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
      renderSchemasNav();
      renderSchemaSections();
      renderConventions();
      renderERD();
      setupSearch();

      // Show first schema by default
      if (SCHEMAS.length > 0) {
        showSchema(SCHEMAS[0].name);
      }
    });

    // Render schema navigation buttons
    function renderSchemasNav() {
      const nav = document.getElementById('schemasNav');
      SCHEMAS.forEach(schema => {
        const btn = document.createElement('button');
        btn.className = 'schema-btn';
        btn.textContent = schema.name; // textContent is safe for plain text
        btn.onclick = () => showSchema(schema.name);
        btn.dataset.schema = schema.name;
        nav.appendChild(btn);
      });
    }

    // Render all schema sections
    function renderSchemaSections() {
      const container = document.getElementById('schemasContainer');
      SCHEMAS.forEach(schema => {
        const section = document.createElement('div');
        section.className = 'schema-section';
        section.id = \`schema-\${escapeHtml(schema.name)}\`;
        section.innerHTML = \`
          <div class="schema-header">
            <h2>\${escapeHtml(schema.name)}</h2>
            <p class="description">\${escapeHtml(schema.description)}</p>
            \${schema.convention ? \`<div class="convention">\${escapeHtml(schema.convention)}</div>\` : ''}
          </div>
          <div class="tables-grid" id="tables-\${escapeHtml(schema.name)}"></div>
        \`;
        container.appendChild(section);

        // Render tables for this schema
        const tablesGrid = section.querySelector(\`#tables-\${escapeHtml(schema.name)}\`);
        schema.tables.forEach(table => {
          const card = createTableCard(table, schema.name);
          tablesGrid.appendChild(card);
        });
      });
    }

    // Create a table card
    function createTableCard(table, schemaName) {
      const card = document.createElement('div');
      card.className = 'table-card';
      card.innerHTML = \`
        <div class="table-card-header">
          <h3>\${escapeHtml(table.name)}</h3>
        </div>
        <div class="table-usage">
          \${escapeHtml(table.usage) || '<em>No usage description</em>'}
        </div>
        <div class="table-columns">
          <em>Click to view full details</em>
        </div>
      \`;
      card.onclick = () => showTableModal(table, schemaName);
      return card;
    }

    // Show table detail in modal
    function showTableModal(table, schemaName) {
      const content = document.getElementById('tableDetailContent');
      content.innerHTML = \`
        <div class="table-detail">
          <h3>\${escapeHtml(schemaName)}.\${escapeHtml(table.name)}</h3>
          <p style="color: var(--gray-600); margin-bottom: 20px;">\${escapeHtml(table.usage) || 'No description available'}</p>
          <div class="columns-detail">
            <h4>Columns</h4>
            <p style="color: var(--gray-500); font-size: 0.9em; margin-bottom: 15px;">
              Click any column for more details
            </p>
            <div id="columnsList"></div>
          </div>
        </div>
      \`;

      // Render columns (placeholder - would need full schema introspection)
      const columnsList = document.getElementById('columnsList');
      columnsList.innerHTML = '<p style="color: var(--gray-500);">Loading column details...</p>';

      document.getElementById('tableModal').classList.add('active');
    }

    function closeTableModal() {
      document.getElementById('tableModal').classList.remove('active');
    }

    // Show specific schema
    function showSchema(schemaName) {
      // Hide all schemas
      document.querySelectorAll('.schema-section').forEach(s => {
        s.classList.remove('active');
      });
      // Remove active from all buttons
      document.querySelectorAll('.schema-btn').forEach(b => {
        b.classList.remove('active');
      });

      // Show selected schema
      document.getElementById(\`schema-\${schemaName}\`).classList.add('active');
      document.querySelector(\`[data-schema="\${schemaName}"]\`).classList.add('active');

      // Scroll to top
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Search functionality
    function setupSearch() {
      const input = document.getElementById('searchInput');
      const results = document.getElementById('searchResults');

      input.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();

        if (query.length === 0) {
          results.innerHTML = '';
          return;
        }

        const matches = [];

        SCHEMAS.forEach(schema => {
          if (schema.name.includes(query)) {
            matches.push({ type: 'schema', name: schema.name, schema: schema.name });
          }

          schema.tables.forEach(table => {
            if (table.name.includes(query) || table.usage.toLowerCase().includes(query)) {
              matches.push({
                type: 'table',
                name: table.name,
                schema: schema.name,
                table: table
              });
            }
          });
        });

        if (matches.length === 0) {
          results.innerHTML = '<div class="no-results">No results found</div>';
          return;
        }

        results.innerHTML = matches.map(match => {
          if (match.type === 'schema') {
            return \`
              <div class="search-result-item" onclick="showSchema('\${escapeHtml(match.schema)}')">
                <div class="search-result-type">Schema</div>
                <strong>\${escapeHtml(match.name)}</strong>
              </div>
            \`;
          } else {
            return \`
              <div class="search-result-item" onclick="showTableModal(\${JSON.stringify(match.table)}, '\${escapeHtml(match.schema)}')">
                <div class="search-result-type">Table</div>
                <strong>\${escapeHtml(match.schema)}.\${escapeHtml(match.name)}</strong>
              </div>
            \`;
          }
        }).join('');
      });
    }

    // Render conventions appendix
    function renderConventions() {
      const list = document.getElementById('conventionList');
      const conventions = [
        {
          name: 'ID Format',
          description: 'All primary keys use UUID format with a 3-character prefix (usr, org, ws, etc.)'
        },
        {
          name: 'Soft Deletes',
          description: 'Most tables include deleted_at timestamp for soft-delete support. Hard deletes are rare.'
        },
        {
          name: 'Audit Trail',
          description: 'Tables have created_at, updated_at, and created_by timestamps for audit purposes.'
        },
        {
          name: 'Tenant Scoping',
          description: 'Workspace-scoped tables include workspace_id. Org-scoped resources include org_id.'
        },
        {
          name: 'Cross-Schema FKs',
          description: 'Foreign keys to other schemas are defined in relations.ts, not inline, to maintain schema independence.'
        },
        {
          name: 'Enum Handling',
          description: 'Enums are PostgreSQL native types, defined per-schema with the enum table definition.'
        }
      ];

      list.innerHTML = conventions.map(c => \`
        <div class="convention-item">
          <h4>\${escapeHtml(c.name)}</h4>
          <p>\${escapeHtml(c.description)}</p>
        </div>
      \`).join('');
    }

    // Render ERD diagram
    function renderERD() {
      const schemaBoxes = SCHEMAS.map(schema => {
        const tableNames = schema.tables.map(t => \`  - \${t.name}\`).join('\\n');
        return \`
          \${schema.name.toUpperCase()} {
            \${tableNames}
          }
        \`;
      }).join('\\n');

      const mermaidDef = \`graph TB
        \${schemaBoxes}
      \`;

      const erdDiv = document.getElementById('erdDiagram');
      erdDiv.innerHTML = mermaidDef;
      mermaid.contentLoaderMarked.cache = {};
      mermaid.run();
    }

    // Close modal on backdrop click
    document.getElementById('tableModal').addEventListener('click', (e) => {
      if (e.target.id === 'tableModal') {
        closeTableModal();
      }
    });
  <\/script>
</body>
</html>`;

  return html;
}

// Main execution
const schemas = parseSchemaFiles();
const html = generateHTML(schemas);

const outputDir = path.join(__dirname, "../../docs/reference");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const outputPath = path.join(outputDir, "db-reference.html");
fs.writeFileSync(outputPath, html);

console.log(`✓ Generated database documentation at ${outputPath}`);
console.log(`  Schemas: ${Object.keys(schemas).length}`);
console.log(`  Total tables: ${Object.values(schemas).reduce((sum, s) => sum + s.tables.length, 0)}`);
