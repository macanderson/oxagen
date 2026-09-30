-- mcp.credentials records how its OAuth client authenticates at the token
-- endpoint.
--
-- Dynamic client registration asks for client_secret_post, and an
-- authorization server that grants it binds the client to that method. The
-- row stored only the client id and secret, so the code exchange and every
-- refresh fell back to the MCP SDK's default, client_secret_basic, and a
-- server that enforces the registered method (Linear) refused them with
-- invalid_client. Every sign-in to such a server failed at the callback.
--
-- NULL means the method was not recorded: a workspace's own OAuth app, or a
-- client registered before this column. The provider then sends
-- client_secret_post, the method Oxagen has always registered with, when the
-- authorization server lists it.
--
-- It also records the callback URL a client was registered with. A registered
-- client is bound to that URL, so when the app's origin changes (app.oxagen.sh
-- to oxagen.app, ADR-215) a client registered under the old one can never
-- complete a sign-in. Sign-in compares the two and registers again when they
-- differ. NULL means not recorded: a client stored before this column.

ALTER TABLE "mcp"."credentials"
  ADD COLUMN "oauth_client_auth_method" text NULL,
  ADD COLUMN "oauth_client_redirect_uri" text NULL;

ALTER TABLE "mcp"."credentials"
  ADD CONSTRAINT "credentials_oauth_client_auth_method_check"
  CHECK (
    "oauth_client_auth_method" IS NULL
    OR "oauth_client_auth_method" IN ('client_secret_basic', 'client_secret_post', 'none')
  );

COMMENT ON COLUMN "mcp"."credentials"."oauth_client_auth_method" IS
  'How the OAuth client authenticates at the token endpoint (RFC 7591 token_endpoint_auth_method), as registration granted it. NULL when not recorded.';

COMMENT ON COLUMN "mcp"."credentials"."oauth_client_redirect_uri" IS
  'The callback URL the OAuth client was registered with, or that the workspace registered its own OAuth app with. NULL when not recorded.';
