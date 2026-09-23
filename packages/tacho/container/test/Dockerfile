# Test only: the production `base` stage with a stub `claude` that drives the
# real hook path. Built by src/contained/launcher.docker.test.ts; never shipped.
ARG BASE=oxagen-contained-base:docker-test
FROM ${BASE}
COPY packages/tacho/container/test/claude-stub.mjs /usr/local/bin/claude
RUN chmod 755 /usr/local/bin/claude
