-- BYOK widens from two routed vendors to any OpenAI-compatible endpoint.
--
-- ADR-053 shipped `provider IN ('openrouter','gateway')` with the endpoint
-- baked into the provider client. Both route to every model in the catalog
-- through one key, which is why they came first — but between them they cannot
-- express "our own OpenAI account", "our own Anthropic account", or a
-- self-hosted vLLM, and every one of those is a key a customer already has.
--
-- Three additions:
--
--   openai              api.openai.com, URL ours to spell
--   anthropic           api.anthropic.com, NATIVE rather than its
--                       OpenAI-compatible endpoint, which drops prompt caching
--                       and extended thinking — the two things the assistant's
--                       long system prompt most depends on
--   openai_compatible   the general case; the customer supplies base_url
--
-- base_url is NOT NULL exactly when the provider is openai_compatible, and the
-- pairing CHECK enforces both directions. The reverse half matters as much as
-- the forward one: without it a row could name 'openrouter' and carry a
-- base_url the client silently ignores, which reads to an operator as a broken
-- assistant rather than a row that says something it does not mean.
--
-- The TLS check is the half of the SSRF guard the database can hold. The range
-- check — loopback, RFC1918, and 169.254.169.254, which is the one that
-- matters, since this endpoint is called WITH the customer's key in an
-- Authorization header — cannot be expressed in SQL (`http://2130706433/` is
-- loopback) and runs in the handler via @oxagen/config/public-url. Holding the
-- scheme here means no future write path, ORM or hand-run, can store `http://`.
--
-- model_map answers a question the routed providers never raised. The
-- platform's tier ids are gateway-shaped (`anthropic/claude-sonnet-5`);
-- OpenRouter and the Gateway both parse that, api.openai.com does not. Asking
-- OpenAI for `anthropic/claude-sonnet-5` is a 404 that would land on the
-- customer's FIRST QUESTION rather than when they saved the key. `{}` and NOT
-- NULL rather than nullable, so every reader gets an object and none branches.
--
-- Backfill: none needed. Every existing row is 'openrouter' or 'gateway', both
-- of which take base_url NULL and model_map '{}', which are the defaults. The
-- ADD COLUMNs are therefore safe on a live table and the CHECKs validate
-- against existing rows without a rewrite.

ALTER TABLE "org"."model_credentials"
  ADD COLUMN "base_url" text NULL,
  ADD COLUMN "model_map" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "org"."model_credentials"
  DROP CONSTRAINT "model_credentials_provider_check";

ALTER TABLE "org"."model_credentials"
  ADD CONSTRAINT "model_credentials_provider_check"
  CHECK ("provider" IN ('openrouter','gateway','openai','anthropic','openai_compatible'));

ALTER TABLE "org"."model_credentials"
  ADD CONSTRAINT "model_credentials_base_url_pairing_check"
  CHECK (("provider" = 'openai_compatible') = ("base_url" IS NOT NULL));

ALTER TABLE "org"."model_credentials"
  ADD CONSTRAINT "model_credentials_base_url_tls_check"
  CHECK ("base_url" IS NULL OR "base_url" LIKE 'https://%');
