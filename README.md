# canvas-expansion-pack
Canvas Expansion Pack adds several bulk editing features to expedite work inside of the LMS.

# Turning it on
After installing the extension, navigate to your Canvas instance and click the extension icon. Click the "Turn on and reload" button if it isn't already active. This should only have to be done once.

# Features
On the Modules page, a green "Batch Edit ▾" button has been added to the top. It has several features:
- Edit Items
    - Allows you to move, publish/unpublish, increase/decrease indent, and remove multiple items inside of a module. Removing items from a module does not delete them from your course.
- Rename Modules
    - Allows you to give all modules unique names at once as opposed to changing each module's name inividually.
- Rename Items
    - Similarly to Rename Modules, allows you to batch rename any items inside of your modules. Warns when changing the name of a page that the URL will change as well.

On the Item Banks page, a green Bulk Permissions Editor button has been added. It has three features:
- Share with a person
    - Allows you to share any or all item banks with a user in the course. The user must either have the Teacher, TA, or Designer roles.
- Share with this course
    - Allows you to share any or all item banks with the course you are currently inside of.
- Review or remove current shares
    - Allows you to check who has access to what item banks, and to revoke access to item banks in bulk.

On the Grades page, an Add Fudge Points button has been added to the three-dot menu ⋮ that appears when you hover on the header cell of a New Quiz column. It allows you to add or remove fudge points to any or all students in the course. 
As this one edits the gradebook, it should be considered extremely experimental, and backups of your gradebook are heavily encouraged.

# Fragility
Item Bank Sharing and Bulk Fudge Points both rely on undocumented parts of the Canvas API and are subject to break upon any update that modifies the API.

# Privacy Policy
There is no way for this tool to store or send user data anywhere other than Canvas and Instructure.