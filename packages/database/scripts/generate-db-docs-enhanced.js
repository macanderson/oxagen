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
  workspace:
    "Workspaces and workspace-scoped configuration. Teams work within workspaces.",
  integration: "External service integrations and connection management.",
  agent: "Agent runtime, skills, background tasks, and approval workflows.",
  workflow: "Workflow definitions and metadata. Execution events flow to ClickHouse.",
  event: "Event definitions and schema metadata. Events flow to ClickHouse.",
  execution:
    "Execution metadata for agents and workflows. Event details in ClickHouse.",
  chat: "Conversations, messages, and chat history. Multi-tenant, workspace-scoped.",
  content: "Generated content, media assets, and workspace documents.",
  graph: "Knowledge graph entities and relationships (Neo4j-backed).",
  evaluation:
    "Evaluation and assessment data for LLM outputs and agent performance.",
  billing: "Billing, subscriptions, invoices, and credit tracking. Stripe-synced.",
  security: "Security policies, audit logs, and compliance tracking.",
  mcp: "MCP server integrations and marketplace configuration.",
  plugin: "Plugin marketplace, installations, and versioning.",
  notification: "Notifications and notification preferences.",
};

// Parse TypeScript schema content to extract detailed column information
function parseTableDefinition(content, tableName) {
  const tableRegex = new RegExp(
    `export const ${tableName}\\s*=\\s*\\w+Schema\\.table\\s*\\(\\s*["']\\w+["']\\s*,\\s*\\{([^}]+)\\}`,
    "s"
  );
  const match = content.match(tableRegex);

  if (!match) return { columns: [], foreignKeys: [] };

  const tableBody = match[1];
  const columns = [];
  const foreignKeys = [];

  // Extract column definitions
  const columnRegex = /(\w+):\s*([^,\n]+(?:\([^)]*\))?[^,\n]*)/g;
  let colMatch;

  while ((colMatch = columnRegex.exec(tableBody)) !== null) {
    const [, colName, colDef] = colMatch;

    // Parse type and constraints
    const typeMatch = colDef.match(
      /(\w+(?:<[^>]+>)?)\s*\(['"]*(\w+)['"]*\)?/
    );
    const isNotNull = colDef.includes(".notNull()");
    const isPrimaryKey = colDef.includes(".primaryKey()");
    const isUnique =
      colDef.includes(".unique()") || colDef.includes("uniqueIndex");
    const defaultValue = colDef.match(/\.default\(([^)]+)\)/)?.[1];
    const hasReferences = colDef.includes(".references(");

    if (hasReferences) {
      const refMatch = colDef.match(/references\(\s*\(\)\s*=>\s*(\w+)\.id/);
      if (refMatch) {
        foreignKeys.push({
          column: colName,
          refTable: refMatch[1],
        });
      }
    }

    columns.push({
      name: colName,
      type: typeMatch ? typeMatch[1] : "unknown",
      dbName: typeMatch ? typeMatch[2] : colName,
      notNull: isNotNull,
      primaryKey: isPrimaryKey,
      unique: isUnique,
      default: defaultValue,
      hasForeignKey: hasReferences,
    });
  }

  return { columns, foreignKeys };
}

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
      tables: [],
    };

    // Extract table definitions
    const tableRegex =
      /export const (\w+)\s*=\s*(\w+Schema)\.table\s*\(\s*["'](\w+)["']/g;
    let match;

    while ((match = tableRegex.exec(content)) !== null) {
      const [, varName, schemaVar, tableName] = match;

      // Extract preceding comment
      const varIndex = content.indexOf(`export const ${varName}`);
      let usage = "";
      if (varIndex > 0) {
        const precedingText = content.substring(Math.max(0, varIndex - 500), varIndex);
        const commentMatch = precedingText.match(/\/\/\s*(.+?)(?:\n|$)/);
        if (commentMatch) {
          usage = commentMatch[1].trim();
        }
      }

      const tableInfo = parseTableDefinition(content, varName);

      schemas[schemaName].tables.push({
        name: tableName,
        varName,
        schema: schemaName,
        columns: tableInfo.columns,
        foreignKeys: tableInfo.foreignKeys,
        usage,
      });
    }
  }

  return schemas;
}

// Generate schema overview (simple, valid Mermaid syntax without relationships)
function generateERD(schemas) {
  const schemaArray = Object.values(schemas);

  // Simple list of schemas and their tables
  let html = '<div style="padding: 20px; font-family: monospace; line-height: 1.8;">';

  schemaArray.forEach((schema) => {
    if (schema.tables.length > 0) {
      html += `<div style="margin-bottom: 20px;">`;
      html += `<strong style="color: var(--primary); font-size: 1.1em;">${schema.name.toUpperCase()}</strong> (${schema.tables.length} tables)<br/>`;
      schema.tables.forEach((table) => {
        html += `&nbsp;&nbsp;• ${table.name}<br/>`;
      });
      html += `</div>`;
    }
  });

  html += '</div>';
  return html;
}

// Generate HTML documentation
function generateHTML(schemas) {
  const schemaList = Object.values(schemas);
  const erdDiagram = generateERD(schemas);

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
      --gray-500: #6b7280;
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
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
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
      grid-template-columns: 300px 1fr;
      gap: 40px;
      padding: 40px;
      max-width: 1800px;
      margin: 0 auto;
    }

    aside {
      position: sticky;
      top: 20px;
      height: fit-content;
    }

    .search-box {
      background: white;
      padding: 20px;
      border-radius: 8px;
      border: 2px solid var(--gray-200);
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      margin-bottom: 20px;
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

    .search-result-name {
      font-weight: 600;
      color: var(--gray-800);
    }

    .schemas-nav {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .schema-btn {
      padding: 10px 12px;
      border: 2px solid var(--gray-300);
      background: white;
      cursor: pointer;
      border-radius: 6px;
      font-weight: 600;
      text-align: left;
      transition: all 0.2s;
      font-size: 0.95em;
    }

    .schema-btn:hover,
    .schema-btn.active {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
    }

    .main-content {
      min-width: 0;
    }

    .schema-section {
      display: none;
    }

    .schema-section.active {
      display: block;
      animation: fadeIn 0.3s;
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
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
    }

    .table-card-header h3 {
      font-size: 1.2em;
      margin-bottom: 4px;
    }

    .table-card-header .table-db-name {
      font-family: monospace;
      font-size: 0.85em;
      opacity: 0.9;
    }

    .table-usage {
      padding: 16px;
      background: var(--gray-50);
      color: var(--gray-700);
      font-size: 0.95em;
      min-height: 40px;
      border-bottom: 1px solid var(--gray-200);
    }

    .table-stats {
      padding: 12px 16px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      font-size: 0.9em;
      background: white;
    }

    .stat {
      display: flex;
      gap: 6px;
    }

    .stat-label {
      color: var(--gray-500);
      font-weight: 600;
    }

    .stat-value {
      color: var(--primary);
      font-weight: 700;
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
      padding: 20px;
    }

    .modal.active {
      display: flex;
    }

    .modal-content {
      background: white;
      border-radius: 12px;
      max-width: 1000px;
      width: 100%;
      max-height: 90vh;
      overflow-y: auto;
      padding: 40px;
      position: relative;
      animation: slideUp 0.3s;
    }

    @keyframes slideUp {
      from {
        transform: translateY(50px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
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

    .table-detail-usage {
      background: var(--gray-50);
      padding: 16px;
      border-radius: 6px;
      margin-bottom: 30px;
      border-left: 3px solid var(--primary);
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
      font-family: monospace;
    }

    .column-detail-name {
      font-weight: 600;
      color: var(--primary);
      margin-bottom: 8px;
      font-size: 1.05em;
    }

    .column-detail-info {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      font-size: 0.9em;
      color: var(--gray-700);
    }

    .detail-label {
      font-weight: 600;
      color: var(--gray-600);
      font-family: sans-serif;
    }

    .detail-value {
      color: var(--gray-800);
      word-break: break-word;
    }

    .column-flags {
      display: flex;
      gap: 6px;
      margin-top: 8px;
      flex-wrap: wrap;
    }

    .flag {
      display: inline-block;
      padding: 3px 8px;
      background: var(--gray-200);
      color: var(--gray-700);
      border-radius: 3px;
      font-size: 0.75em;
      font-weight: 600;
      text-transform: uppercase;
      font-family: sans-serif;
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

    .flag.notnull {
      background: #3b82f6;
      color: white;
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

      aside {
        position: relative;
        top: auto;
      }
    }

    @media print {
      .search-box,
      aside {
        display: none;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>Oxagen Database Schema Reference</h1>
    <p>Interactive database documentation with searchable tables, columns, types, and relationships</p>
  </header>

  <div class="container">
    <!-- Search sidebar -->
    <aside>
      <div class="search-box">
        <input
          type="text"
          id="searchInput"
          placeholder="Search tables, columns..."
          autocomplete="off"
        >
        <div class="search-results" id="searchResults"></div>
      </div>

      <div class="schemas-nav" id="schemasNav"></div>
    </aside>

    <!-- Main content -->
    <main class="main-content">
      <div id="schemasContainer"></div>

      <!-- ERD Section -->
      <div class="erd-section">
        <h2>Entity Relationship Diagram</h2>
        <p style="color: var(--gray-600); margin-bottom: 20px;">
          Shows all tables and their relationships. Tables are grouped by schema. Click on table names in the diagram to view details.
        </p>
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

  <script async src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"><\/script>
  <script>
    // Utility to safely escape HTML
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Initialize mermaid after DOM is ready
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof mermaid !== 'undefined') {
        mermaid.initialize({
          startOnLoad: true,
          theme: 'default',
          securityLevel: 'loose',
          erDiagram: {
            useMaxWidth: true
          }
        });
        mermaid.contentLoaderMarked.cache = {};
        mermaid.run();
      }
    });
  </script>

    // Data
    const SCHEMAS = ${JSON.stringify(schemaList)};

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
        btn.textContent = schema.name;
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
          <div class="table-db-name">\${escapeHtml(schemaName)}.\${escapeHtml(table.name)}</div>
        </div>
        <div class="table-usage">
          \${escapeHtml(table.usage) || '<em>No description</em>'}
        </div>
        <div class="table-stats">
          <div class="stat">
            <span class="stat-label">Columns:</span>
            <span class="stat-value">\${table.columns.length}</span>
          </div>
          <div class="stat">
            <span class="stat-label">FKs:</span>
            <span class="stat-value">\${table.foreignKeys.length}</span>
          </div>
        </div>
      \`;
      card.onclick = () => showTableModal(table, schemaName);
      return card;
    }

    // Show table detail in modal
    function showTableModal(table, schemaName) {
      const content = document.getElementById('tableDetailContent');

      const columnsHtml = table.columns.map(col => {
        const flags = [];
        if (col.primaryKey) flags.push('pk');
        if (col.hasForeignKey) flags.push('fk');
        if (col.unique) flags.push('unique');
        if (col.notNull) flags.push('notnull');

        return \`
          <div class="column-detail">
            <div class="column-detail-name">\${escapeHtml(col.name)}</div>
            <div class="column-detail-info">
              <div>
                <div class="detail-label">Type</div>
                <div class="detail-value">\${escapeHtml(col.type)}</div>
              </div>
              <div>
                <div class="detail-label">DB Column</div>
                <div class="detail-value">\${escapeHtml(col.dbName)}</div>
              </div>
              \${col.default ? \`
              <div>
                <div class="detail-label">Default</div>
                <div class="detail-value">\${escapeHtml(col.default)}</div>
              </div>
              \` : ''}
            </div>
            \${flags.length > 0 ? \`
            <div class="column-flags">
              \${flags.map(f => \`<span class="flag \${f}">\${f}</span>\`).join('')}
            </div>
            \` : ''}
          </div>
        \`;
      }).join('');

      content.innerHTML = \`
        <div class="table-detail">
          <h3>\${escapeHtml(schemaName)}.\${escapeHtml(table.name)}</h3>
          <div class="table-detail-usage">
            \${escapeHtml(table.usage) || 'No description available'}
          </div>
          <div class="columns-detail">
            <h4>Columns (\${table.columns.length})</h4>
            <div>\${columnsHtml}</div>
          </div>
          \${table.foreignKeys.length > 0 ? \`
          <div class="columns-detail">
            <h4>Foreign Keys (\${table.foreignKeys.length})</h4>
            <div>
              \${table.foreignKeys.map(fk => \`
                <div class="column-detail">
                  <div class="column-detail-name" style="color: var(--error);">
                    \${escapeHtml(fk.column)} → \${escapeHtml(fk.refTable)}
                  </div>
                </div>
              \`).join('')}
            </div>
          </div>
          \` : ''}
        </div>
      \`;

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
      document.getElementById(\`schema-\${escapeHtml(schemaName)}\`).classList.add('active');
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

            // Search columns
            table.columns.forEach(col => {
              if (col.name.includes(query) || col.type.includes(query)) {
                matches.push({
                  type: 'column',
                  name: \`\${table.name}.\${col.name}\`,
                  schema: schema.name,
                  table: table
                });
              }
            });
          });
        });

        if (matches.length === 0) {
          results.innerHTML = '<div class="no-results">No results found</div>';
          return;
        }

        // Remove duplicates
        const uniqueMatches = [];
        const seen = new Set();
        matches.forEach(m => {
          const key = \`\${m.type}-\${m.schema}-\${m.name}\`;
          if (!seen.has(key)) {
            seen.add(key);
            uniqueMatches.push(m);
          }
        });

        results.innerHTML = uniqueMatches.map(match => {
          if (match.type === 'schema') {
            return \`
              <div class="search-result-item" onclick="showSchema('\${escapeHtml(match.schema)}')">
                <div class="search-result-type">Schema</div>
                <div class="search-result-name">\${escapeHtml(match.name)}</div>
              </div>
            \`;
          } else if (match.type === 'table') {
            return \`
              <div class="search-result-item" onclick="showTableModal(\${JSON.stringify(match.table)}, '\${escapeHtml(match.schema)}')">
                <div class="search-result-type">Table</div>
                <div class="search-result-name">\${escapeHtml(match.schema)}.\${escapeHtml(match.name)}</div>
              </div>
            \`;
          } else {
            return \`
              <div class="search-result-item" onclick="showTableModal(\${JSON.stringify(match.table)}, '\${escapeHtml(match.schema)}')">
                <div class="search-result-type">Column</div>
                <div class="search-result-name">\${escapeHtml(match.name)}</div>
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
        },
        {
          name: 'Mixin Pattern',
          description: 'Common column sets (id, audit, soft delete, org scope) are defined as mixins in _mixins.ts.'
        }
      ];

      list.innerHTML = conventions.map(c => \`
        <div class="convention-item">
          <h4>\${escapeHtml(c.name)}</h4>
          <p>\${escapeHtml(c.description)}</p>
        </div>
      \`).join('');
    }

    // Render schema overview
    function renderERD() {
      const erdDiv = document.getElementById('erdDiagram');
      erdDiv.innerHTML = \`${erdDiagram}\`;
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

const totalTables = Object.values(schemas).reduce((sum, s) => sum + s.tables.length, 0);
const totalColumns = Object.values(schemas).reduce(
  (sum, s) => sum + s.tables.reduce((ts, t) => ts + t.columns.length, 0),
  0
);

console.log(`✓ Generated database documentation at ${outputPath}`);
console.log(`  Schemas: ${Object.keys(schemas).length}`);
console.log(`  Total tables: ${totalTables}`);
console.log(`  Total columns: ${totalColumns}`);
