-- org.model_credentials records whether the endpoint honoured a JSON-schema
-- request when the verification probe last asked (#3314).
--
-- The provider client told the AI SDK that every OpenAI-compatible endpoint
-- supports structured outputs, whether or not anyone had checked.
-- verify_model_credential now asks an openai_compatible endpoint one
-- JSON-schema question and stores the answer here. The client sends a JSON
-- schema only when it is true, and otherwise puts the schema in the prompt.
--
-- NULL means the probe never asked: every provider but openai_compatible, and
-- a row verified before this column. set_model_credential resets it to NULL,
-- because a new key or endpoint makes the old answer stale.

ALTER TABLE "org"."model_credentials"
  ADD COLUMN "structured_outputs" boolean NULL;

COMMENT ON COLUMN "org"."model_credentials"."structured_outputs" IS
  'Whether the endpoint honoured a response_format JSON-schema request when verify_model_credential last asked. NULL when never asked.';
