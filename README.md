# canvas-expansion-pack
Canvas Expansion Pack adds batch editing, reporting, and improved navigation to expedite work inside of the LMS.

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
    - Allows you to give all modules unique names at once as opposed to changing each module's name individually.
- Rename Items
    - Similarly to Rename Modules, allows you to batch rename any items inside of your modules. Warns when changing the name of a page that the URL will change as well.
A similar toolset is available on the Assignments page, except for a few key differences:
- Deletion of assignments from the assignments page _will delete them from your course_
- Assignments can be moved from assignment group to assignment group instead of module to module
- No indentation
### Item Banks
On the Item Banks page, a green "Batch Edit ▾" button has been added. It has four features:
- Share with a person
    - Allows you to share any or all item banks with a user in the course. The user must either have the Teacher, TA, or Designer roles.
- Share with this course
    - Allows you to share any or all item banks with the course you are currently inside of.
- Review or remove access
    - Allows you to check who has access to what item banks, and to revoke access to item banks in bulk.
- Make a bank from a quiz
    - Creates a bank named after a selected quiz, moves the questions into it, and links the quiz to that bank.
### Fudge Points
On the Grades page, an Add Fudge Points button has been added to the three-dot menu ⋮ that appears when you hover on the header cell of a New Quiz column. It allows you to add or remove fudge points to any or all students in the course. 
As this one edits student grade data, it should be considered _extremely experimental_, and backups of your gradebook are heavily encouraged.
## Course Navigation
### Moodle-Style Breadcrumb Navigation
Replaces the default breadcrumb navigation behavior with one based on modules. When browsing the course through the Modules screen, clicking on an item will allow you to navigate back to the module it was in via the breadcrumbs. 
## Advanced Reporting
There are new reports added to Canvas by this extension. They mostly collate data available elsewhere inside the LMS into a more readable format. They can be accessed via the "Advanced Reports ▾" button on any page that includes the View Progress button. These reports are:
- Class Progress
  - Collates completion condition status for entire class on one list.
- Submission Log
  - Similar in functionality to Moodle's logs. Course activity and submissions are shown here. Some of this info is mirrored elsewhere in Canvas; this is an alternate way of accessing it.
  
# Notes on Fragility
Item Bank Sharing, Submission Log, and Bulk Fudge Points all rely on undocumented parts of the Canvas API and are subject to break upon any update that modifies the API. Generating question banks from quizzes signs into the quiz editor through a hidden browser frame. 

# Privacy Policy
There is no way for this tool to store or send user data anywhere other than your Canvas instance.
