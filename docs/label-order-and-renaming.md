# Arrange and rename labels

In the expanded mail sidebar, hold a label row briefly, then move it with the mouse or your finger. Labels stay on a single line; long names are truncated visually and their complete path is available on hover. A preview and blue insertion line show the destination; releasing saves the new order. Long lists scroll automatically near their top and bottom edges. Escape or cancelling the touch gesture leaves the order unchanged. The three-dot menu also offers up/down commands for keyboard users.

Reordering stays within the current sibling group. Moving a parent carries its children with it; nesting is changed separately in label settings. Order is saved per user, mailbox and sibling group on the server, so it is shared across that user's devices. Changes appear immediately and save in the background; other devices refresh on focus, reconnect and every 30 seconds. Local storage remains the fallback before loading. An existing desktop browser order is adopted only when no server order has been saved for that group; open the desktop where you previously arranged labels to adopt that order. Phone caches are not adopted automatically, because their older orders have no timestamps. New manual changes on any device always save to the account. Read-only delegates may save their own display preferences without changing the mailbox or other users' order.

Open a label's three-dot menu and choose **Rename**. Saving updates the existing label, preserving its ID, children, assigned messages and rule targets. Sidebar paths, message label chips and label pickers refresh after saving. Names must be nonempty, at most 80 characters and unique within the mailbox. Renaming requires mailbox management access; read-only users can still rearrange their local sidebar.

Choose **Change color** in the same menu to recolor an existing label. The eight
named colors support touch and keyboard selection; Save persists the color on
the server and refreshes label consumers. Cancel leaves the saved color intact;
a failed save retains the selection for retry. Management access is required and
the API accepts only six-digit hex colors. Message assignments and label IDs stay
unchanged. API and browser checks cover permissions, invalid values, retries and
cancellation at 320px, 390px, 430px, landscape and desktop widths.
