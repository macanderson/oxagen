"""Illustrative sketch: wrapping a LangChain agent with Tacho.

Design reference only — not a runnable package. Shows the two integration
styles from overview.md §4: the one-line object wrap (a) and the SDK-native
callbacks it desugars to (b).
"""

import tacho  # would be: pip install tacho

# --- Style (a): one-line object wrap -------------------------------------
#
# tacho.wrap() detects the SDK (registry/duck-typing), returns a proxy that
# installs a LangChain callbacks handler internally, and starts a session
# (genesis event binds agent identity + wrapper attestation + session key).

from langchain.agents import AgentExecutor

executor = AgentExecutor(agent=agent, tools=tools)
executor = tacho.wrap(
    executor,
    agent_id="agnt_support_refunds",
    fleet_id="flt_acme_support",
    # Telemetry is fail-open; enforcement (Phase 2+) is fail-closed.
    enforcement=tacho.Enforcement(
        policy_bundle="cached",       # standing grants, evaluated locally
        on_elevation="request",       # ask the PDP; block until token/deny
    ),
)

result = executor.invoke({"input": "refund order 123"})
# Every LLM call, tool call, and (opt-in) ambient file/network access flowed
# through the wrapper: hash-chained events, zero blocking on the hot path.


# --- Style (b): what (a) desugars to -------------------------------------
#
# For users who prefer explicit wiring, the SDK-native handler is public.

from langchain.callbacks.base import BaseCallbackHandler


class TachoCallbackHandler(BaseCallbackHandler):  # sketch of the real one
    """Maps LangChain lifecycle to tacho/1.0 events (trace-model.md §1)."""

    def __init__(self, session: "tacho.Session") -> None:
        self.session = session

    def on_llm_end(self, response, **kwargs) -> None:
        self.session.emit(kind="llm_call", body=tacho.llm_body(response))

    def on_tool_start(self, serialized, input_str, **kwargs) -> None:
        action = tacho.canonical_action(serialized, input_str)
        # Enforcement hook: standing grant? else elevation (approval-tokens.md)
        token = self.session.authorize(action)   # fail-closed; may raise Denied
        self.session.emit(kind="token_use", body={"token_id": token.id})

    def on_tool_end(self, output, **kwargs) -> None:
        self.session.emit(kind="tool_call", body=tacho.tool_body(output))


session = tacho.start_session(agent_id="agnt_support_refunds")
executor = AgentExecutor(
    agent=agent, tools=tools, callbacks=[TachoCallbackHandler(session)]
)
