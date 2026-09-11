# Confluence Cloud API use

The Confluence target uses REST API v2 for page discovery, page creation, page
updates, page deletion, attachment discovery, and page content properties.

The target has two narrow REST API v1 exceptions:

- Upload or update a page attachment.
- Add labels to a page.

Confluence Cloud REST API v2 currently provides read and delete attachment
operations, but it does not provide an attachment upload operation. Its label
operations are read-only. The target must remove these v1 calls when equivalent
v2 write operations become available.

All requests must stay on the configured Confluence origin. Credentials must
not follow a redirect to another origin.
