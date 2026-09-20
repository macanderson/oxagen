# GitHub identity and polling

Repository-local issue numbers collide when one connection covers multiple repositories. Correct the record identity before expanding the connector's target set. Preserve an old graph node only when durable provenance proves identity, and retain the new global key so later repository renames still find it.

A connector can paginate correctly while its caller silently truncates the result. Inspect cursor advancement in the worker as well as page fetching. The existing 200-record limit advanced over unseen records; overflow now fails with its previous cursor intact.

Use explicit branch refspecs for every push. This repository's push.default setting may otherwise target an inherited upstream.
