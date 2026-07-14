# Zombie Schema

- cms (schema)
- cms.book_editions
- cms.book_access_codes
- cms.leads
- content (schema)
- content.generated_assets
- content.documents
- org.org_users (this is empty! i am shocked! how is one user a part of many orgs or how is one org supposed to know who its users are - why wouldn't we combine the invitation to an org and the user for an org by havign a column that holds the status of 'invited', 'accepted', 'cancelled' (after 2 weeks of not accepting we need a sweep job to switch status to cancel because invited users hold a license), 'declined' (we need a decline button on the page rendered to accept an invitation to an org as a user.))
-
