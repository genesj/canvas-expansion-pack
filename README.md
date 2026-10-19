# canvas-expansion-pack
Canvas Expansion Pack adds several bulk editing features to expedite work inside of the LMS.

# Installation
Install via the [Chrome](https://chromewebstore.google.com/detail/canvas-expansion-pack/fkmfjgaabjocfcodecdcikdbkekoaeho) or [Firefox](https://addons.mozilla.org/en-US/firefox/addon/canvas-expansion-pack/) Web Stores to automatically receive updates. Manual installation is not recommended or supported.

# Turning it on
After installing the extension, navigate to your Canvas instance and click the extension icon. Click the "Turn on and reload" button if it isn't already active. This should only have to be done once.

# Features
## Batch Editing
### Assignments and Modules
On the Modules page, a green "Batch Edit ▾" button has been added to the top. It has several features:
- Edit Items
    - Allows you to move, publish/unpublish, increase/decrease indent, and remove multiple items inside of a module. Removing items from a module does not delete them from your course.
- Rename Modules
    - Allows you to give all modules unique names at once as opposed to changing each module's name inividually.
- Rename Items
    - Similarly to Rename Modules, allows you to batch rename any items inside of your modules. Warns when changing the name of a page that the URL will change as well.
The same tools are available on the Assignments page. Batch Renaming of Assignment Groups is available in lieu of Module renaming.
### Item Banks
On the Item Banks page, a green Bulk Permissions Editor button has been added. It has three features:
- Share with a person
    - Allows you to share any or all item banks with a user in the course. The user must either have the Teacher, TA, or Designer roles.
- Share with this course
    - Allows you to share any or all item banks with the course you are currently inside of.
- Review or remove current shares
    - Allows you to check who has access to what item banks, and to revoke access to item banks in bulk.
### Fudge Points
On the Grades page, an Add Fudge Points button has been added to the three-dot menu ⋮ that appears when you hover on the header cell of a New Quiz column. It allows you to add or remove fudge points to any or all students in the course. 
As this one edits student grade data, it should be considered _extremely experimental_, and backups of your gradebook are heavily encouraged.
## Course Navigation
### Moodle-Style Breadcrumb Navigation
Replaces the default breadcrumb navigation behavior with one based on modules. When (and only when) browsing the course through the Modules screen, clicking on an item will allow you to navigate back to the module it was in via the breadcrumbs. 

# Notes on Fragility
Item Bank Sharing and Bulk Fudge Points both rely on undocumented parts of the Canvas API and are subject to break upon any update that modifies the API.

# Privacy Policy
There is no way for this tool to store or send user data anywhere other than your Canvas instance.
