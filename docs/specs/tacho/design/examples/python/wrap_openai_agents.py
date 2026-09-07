"""Illustrative sketch: wrapping an OpenAI Agents SDK agent with Tacho.

Design reference only — not a runnable package. The Agents SDK exposes
RunHooks and trace processors; tacho.wrap() installs both.
"""

import tacho
from agents import Agent, Runner, RunHooks


# --- Style (a): one-line wrap --------------------------------------------

agent = Agent(name="deploy-bot", instructions="...", tools=[deploy, rollback])
agent = tacho.wrap(agent, agent_id="agnt_deploy_bot", fleet_id="flt_platform")

result = Runner.run_sync(agent, "deploy service X to staging")


# --- Style (b): the RunHooks it desugars to ------------------------------

class TachoRunHooks(RunHooks):  # sketch of the real adapter
    def __init__(self, session: "tacho.Session") -> None:
        self.session = session

    async def on_tool_start(self, context, agent, tool) -> None:
        action = tacho.canonical_action(tool, context)
        # "deploy to prod" has no standing grant → elevation:
        #   approval_request event → PDP (Cedar) → maybe human queue →
        #   Biscuit minted, bound to this session's ephemeral key →
        #   verified offline here. Raises tacho.Denied on deny (fail-closed).
        self.token = await self.session.authorize_async(action)

    async def on_tool_end(self, context, agent, tool, result) -> None:
        self.session.emit(
            kind="tool_call",
            body=tacho.tool_body(tool, result, token_id=self.token.id),
        )

    async def on_llm_end(self, context, agent, response) -> None:
        self.session.emit(kind="llm_call", body=tacho.llm_body(response))


session = tacho.start_session(agent_id="agnt_deploy_bot")
result = Runner.run_sync(agent, "deploy service X", hooks=TachoRunHooks(session))
