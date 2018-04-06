**Node forums is a forum solution made by Snoozy1995. The solution is made using primarily javascript.**

**Components:**

* MongoDB database
* Express webserver
* Express session
* MongoDB session store
* Pug template engine
* socket.io

**Features:**

* Realtime UI updates
* Discussion boards
* Alternative views
* Customization
* Modular approach


**Source Documentation**

**Objects:**

  * permissionGroup
  * userController(socket)
    * .updateUI
    * .updateUIALL
    * .renderUI
    * .getPermissionsTree
    * .encrypt
    * .setSession
    * .loadUser
    * .disconnect
    * .createComment
    * .createDiscussion
    * .hasPermission
    * .ping
    * .registerUI
    * .unregisterUI
    * Events:
      * Test
  * discussionTree
    * .getComments
    * .retrieveUser
    * .permissionFilter
    * .pendingF
  * directoryTree(directories,config={})
    * .getChildren
    * .retrieveUser
    * .findLatestDiscussion
    * .permissionFilter
    * .pendingF
  * originController
    * .testX