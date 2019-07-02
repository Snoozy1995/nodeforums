/*process.on('uncaughtException', function (err) {
LOG(err); //Send some notification about the error
process.exit(1); });*/
//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//-------------------------------------------CONSTANTS----------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
const   sanitizeHtml    = require('sanitize-html');
const   config          = require("./config/config");
const   express         = require('express');
const   app             = express();
const   path            = require('path');
const   compression     = require('compression')
const   http            = require('http').Server(app);
const   session         = require('express-session');
const   MongoDBStore    = require('connect-mongodb-session')(session);
const   ObjectId        = require('mongodb').ObjectId; 
const   io              = require('socket.io')(http);
const   moment          = require("moment");
//const   fs              = require("fs");
const   crypto          = require("crypto");
var sharedsession = require("express-socket.io-session");
var /*global={},*/clients=[],permissionGroups={},permissionGroupsArray=[];

global.sanitize={
  allowedTags: [ 'h1','h2','h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol',
  'nl', 'li', 'b', 'i', 'strong', 'em', 's','u', 'code', 'hr', 'br', 'div',
  'table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td', 'pre', 'iframe' ]
};

var MongoClient = require('mongodb').MongoClient;
var store = new MongoDBStore({uri:'mongodb://'+config.mongoIP+':'+config.mongoPort+'/',databaseName:config.mongoDB,collection: 'web_sessions'});
store.on('error', function(error) { assert.ifError(error); assert.ok(false); });
const session1=session({
  secret: config.session_secret,
  resave: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 1 week
  saveUninitialized: true,
  store: store
});
app.use(compression());
app.use(session1);
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'pug');
io.use(sharedsession(session1));
function endProcess(err){ LOG(err); process.exit(1); }
var LOG = function(){ if(config.debug) return console.log.apply(console, arguments); }
if(!config.mongoIP||!config.mongoPort||!config.mongoDB||!config.session_secret||!config.mongoSecret) return endProcess("Configuration file not properly setup. Please refer to config/config.js");
//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//---------------------------------------MongoDB functions------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
function connectToMongo(){
  MongoClient.connect('mongodb://'+config.mongoIP+':'+config.mongoPort+'/?maxPoolSize=1', function(err, db) {
    if (err) throw err;
    global.dboriginal=db;
    global.db = db.db(config.mongoDB);
    global.db.on('close',()=>connectToMongo());
    loadRoutes();
    getCollectionArray("permission_groups",(res)=>{
      for(var i=0;i<res.length;i++){
        var permGroup=new permissionGroup(res[i]);
        permissionGroups[res[i]._id.toString()]=permGroup;
        permissionGroupsArray.push(permGroup);
      }
    });
    getCollectionArray("discussions",(resx)=>{
      global.discussions=resx;
    },{findBy:{directory:{$exists:true}},count:true});
    global.directoryTree=new directoryTree();
  });
}
connectToMongo();

function getCollectionArray(collection,next,options={}){
  if(!collection||!next||!global||!global.db) return;
  var res=global.db.collection(collection).find(options.findBy);
  if(options.sortBy){ res.sort(options.sortBy); }
  if(options.limit){ res.limit(options.limit); }
  if(options.count) return res.count((e,r)=>documentHandle(e,r,next));
  return res.toArray((err, res)=>documentHandle(err,res,next));
}
function insertDocument(collection,insert,next){
  if(insert instanceof Object) return global.db.collection(collection).insertOne(insert,(err, res)=>documentHandle(err,res,next));
  if(insert.constructor instanceof Array) return global.db.collection(collection).insertMany(insert,(err, res)=>documentHandle(err,res,next));
  return true;
}
function documentHandle(err,res,next){
  if (err) throw err;
  if(next) return next(res);
  return true;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//-------------------------------------PERMISSION FUNCTIONS-----------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
const PERMISSIONS={
  READ:0x1,
  WRITE:0x2,
  MODERATOR:0x4,
  ADMINISTRATOR:0x8
};

function hasPermission(permission,permissions){
  if((permissions&PERMISSIONS.ADMINISTRATOR)==PERMISSIONS.ADMINISTRATOR) return true;
  if(typeof permission=="number") return ((permissions&permission)==permission)
  if(!typeof permission=="string") return false;
  if(!PERMISSIONS[permission]) return;
  return ((permissions&PERMISSIONS[permission])==PERMISSIONS[permission])
}

function permissionGroup(config={}){
  this.name=config.name;
  this.permissions=config.permissions;
  this._id=config._id;
  if(config.color) this.color=config.color;
  if(config.default) this.default=config.default;
  return this;
}

function getDefaultGroup(){
  if(!permissionGroupsArray.length) return false;
  var result=permissionGroupsArray.filter(val=>{ if(val.default) return true; });
  if(result.length) return result[0];
  return false;
}

/**
 * @description Updates all clients on said page accordingly if a change happens. That's atleast the idea of it.
 * @param {integer} id 
 * @param {string} ui 
 */
function clients_update(id,ui){
  for(var i=0;i<clients.length;i++){
    var client=clients[i];
    if(client.pageid!=id) continue;
    if(ui){ client.updateUI(ui); }
    else{ client.updateUIALL(); }
  }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//---------------------------------------user Controller--------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
function is_valid_email(email){ return /^.+@.+\..+$/.test(email); }
io.on("connection",(socket)=>clients.push(new userController(socket)));
function userController(socket){
  this.socket=socket;
  this.session=socket.handshake.session;
  if(this.session&&this.session.logged&&this.session.username){ this.loadUser(this.session.username); }
  this.update_ui={};
  this.socket.on("pong1",(r)=>LOG("Socket ping:",(r-this.pingVal)+"ms request",(Date.now()-r)+"ms response",(Date.now()-this.pingVal)+"ms total"));
  this.socket.on("ping1",()=>this.ping());
  this.socket.on("login",(username,password)=>{
    getCollectionArray("users",(res)=>{
      if(!res.length) return socket.emit("loginError","The information provided isn't found in our database. Please check your input and try again.");
      return this.loadUser(username,true,true);
    },{findBy:{username:username,password:this.encrypt(password)}});
  });
  this.socket.on("register",(username,password,email)=>{
    if(!is_valid_email(email)) return; //Not valid email
    if(!password.length) return;
    if(!username.length) return; //Not valid username
    insertDocument("users",{username:username,password:this.encrypt(password),email:email,groups:[getDefaultGroup()._id.toString()]},(res)=>{
      if(!res||!res.ops.length) return;
      return this.loadUser(username,true,true);
    });
  });
  this.socket.on("usernameAvailable",(username)=>{
    getCollectionArray("users",(res)=>{
      if(!res.length) return socket.emit("usernameAvailable",true);
      return socket.emit("usernameAvailable",false);
    },{findBy:{username:username}});
  });
  this.socket.on("emailAvailable",(email)=>{
    getCollectionArray("users",(res)=>{
      if(!res.length) return socket.emit("emailAvailable",true);
      return socket.emit("emailAvailable",false);
    },{findBy:{email:email}});
  });
  this.socket.on("createcomment",(disc,comt)=>this.createComment(disc,comt));
  this.socket.on("creatediscussion",(directory,name,text)=>this.createDiscussion(directory,name,text));
  this.socket.on("likecomment",(comment)=>{});
  this.socket.on("likediscussion",(discussion)=>{});
  this.socket.on("register ui",(ui,target,config)=>this.registerUI(ui,target,config));
  this.socket.on("unregister ui",(ui)=>this.unregisterUI(ui));
  this.socket.on("disconnect",()=>this.disconnect());
  if(this.socket.handshake.query.id) this.pageid=this.socket.handshake.query.id;
  return this;
}
userController.prototype.unregisterUI=function(ui){
  //Should check beforehand if target is taken, if it is then remove it.
  if(this.update_ui&&this.update_ui[ui]){
    this.renderUI(ui,"");
    setTimeout(()=>{
      delete this.update_ui[ui];
    },250)
  }
  return this;
}
userController.prototype.registerUI=function(ui,target,config={}){
  //Should check beforehand if target is taken, if it is then remove it.
  var len=Object.keys(this.update_ui).length;
  if(config.pageid!=undefined){ this.pageid=config.pageid; }
  if(config.pushstate!=undefined&&target!=".modalView"){
    this.pageid=config.pushstate;
    //Should check current url, if same url then dont.*
    this.socket.emit("pushstate","/"+config.pushstate,{ui:ui,target:target,id:this.pageid});
    this.updateUI("originView");
  }
  if(config.pushstate!=undefined&&target==".modalView"){ this.modalid=config.pushstate; }
  if(!len){
    this.update_ui[ui]=target;
    this.updateUI(ui);
    return this;
  }
  var i=0;
  for(var obj in this.update_ui){
    i++
    if(this.update_ui[obj]==target&&obj!=ui||obj==ui&&this.update_ui[obj]!=target){ this.unregisterUI(obj); }
    if(i==len){
      this.update_ui[ui]=target;
      this.updateUI(ui);
      return this;
    }
  }
}
userController.prototype.ping=function(){
  this.pingVal=Date.now();
  this.socket.emit("ping1");
  return this;
}
userController.prototype.hasPermission=function(permission,id){
  if(!this.permissionsTree) return false;
  if(hasPermission(PERMISSIONS.ADMINISTRATOR,this.permissionsTree.default)) return true;
  if(this.permissionsTree[id]){ 
    if(hasPermission(PERMISSIONS.ADMINISTRATOR,this.permissionsTree[id])||hasPermission(permission,this.permissionsTree[id])) return true;
    else return false;
  }else return hasPermission(permission,this.permissionsTree.default);
}
userController.prototype.createDiscussion=function(directory,name,text){
  if(!this.hasPermission(PERMISSIONS.WRITE,directory)) return;
  insertDocument("discussions",{directory:ObjectId(directory),name:name,text:text,created:moment().format(),author:this.session._id},(res)=>{
    if(!res.insertedId) return;
    if(global.directoryTree.directories[directory]&&!global.directoryTree.directories[directory].discussions){ global.directoryTree.directories[directory].discussions=[]; }
    global.directoryTree.directories[directory].discussions.unshift(res.ops[0]);
    //Need to rebuild clients directory tree also technically or atleast merge the two which would be fairly doable.
    global.discussions++;
    this.socket.emit("redirect","/"+res.insertedId.toString());
    clients_update(directory,"threeStatistics");
    clients_update(directory,"childView");
  });
  return this;
}
userController.prototype.createComment=function(discussion,comment,parent){
  if(!this.hasPermission(PERMISSIONS.WRITE,discussion)) return;
  var insert={discussion:ObjectId(discussion),text:sanitizeHtml(comment,global.sanitize),created:moment().format(),author:this.session._id};
  if(parent){ insert.parent=parent; }
  insertDocument("discussions",insert,(res)=>{ clients_update(discussion,"discussionView"); });
  return this;
}
userController.prototype.disconnect=function(){ clients.splice(this,1); return this; }

userController.prototype.loadUser=function(username,setSession=false,redirect=false){
  getCollectionArray("users",(res)=>{
    if(!res.length) return this.session.destroy(function(err){ 
      if(err) return LOG(err); 
      this.disconnect();
      this.socket.emit("redirect","/");
    });
    if(setSession){ this.setSession({logged:true,username:username,email:res[0].email,_id:res[0]._id}); }
    this.groups=res[0].groups;
    this.getPermissionsTree();
    //this.permissions=res[0].permissions;
    if(redirect){ setTimeout(()=>this.socket.emit("redirect","/"),500); }
  },{findBy:{username:username}});
}

/**
 * @description Sets the users session.
 * @param {object} session
 */
userController.prototype.setSession=function(session={}){
  for(var index in session){ this.session[index]=session[index]; }
  this.session.save();
  return this;
}

/**
 * @description  Encrypt password, applying sha256 encryption.
 * @param {string} password
 * @returns {string}
*/
userController.prototype.encrypt=function(password){
  if(password.length!=64) return;
  var hash = crypto.createHmac('sha256',config.mongoSecret);
  hash.update(password.substring(16,48));
  return hash.digest('hex');
}

/**
 * @description  Updates all UI elements that currently are in use by the userController.
*/
userController.prototype.updateUIALL=function(){ for(var key in this.update_ui){ this.updateUI(key); } }

/**
 * @description Updates the requested UI.
 * @param {string} ui
*/
userController.prototype.updateUI=function(ui){
  var res=this;
  switch(ui){
    case "discussionView":
      return getCollectionArray("discussions",(result)=>{
        if(!result.length) return LOG("This should be handled... Error getting discussionView @ userController.updateUI... Please contact development team if this error occurs on a production stage.");
        return new discussionTree(result[0],{ next:(that)=>app.render("api/"+ui,{permissions:res.permissionsTree,session:res.session,discussion:that.discussion,comments:that.commentsArray},(err,html)=>res.renderUI(ui,html,err)) });
      },{findBy:{_id:ObjectId(this.pageid)}});
    case "directoryView":
      return app.render("api/"+ui,{session:this.session,directories:this.categories},(err,html)=>res.renderUI(ui,html,err));
    case "childView":
      return app.render("api/"+ui,{session:this.session,directories:[this.directoriesEx[this.pageid]]},(err,html)=>res.renderUI(ui,html,err));
    case "railProfileView": return app.render("api/"+ui,{session:this.session},(err,html)=>res.renderUI(ui,html,err));
    case "threeStatistics": return app.render("api/"+ui,{statistics:{online:clients.length,discussions:global.discussions}},(err,html)=>res.renderUI(ui,html,err));
    case "originView":
      return new originController(this.pageid,(r)=>{
        app.render("api/"+ui,{origin:r},(err,html)=>res.renderUI(ui,html,err));
      });
    case "profileView": //Should check for permissions @ the requested user. Also originContrller needs rework if its to support user profile breadcrumbs.
      if(!this.modalid) return LOG("This should be handled... Error getting profileView @ userController.updateUI... Please contact development team if this error occurs on a production stage.");
      return getCollectionArray("users",(discx)=>{
        if(!discx.length) return LOG("This should be handled... Error finding user through mongodb get query. User might not exist. Please contact development team and make us aware, if this error occurs on production stage.");
        return app.render("api/"+ui,{session:res.session},(err,html)=>res.renderUI(ui,html,err));
      },{findBy:{_id:ObjectId(this.modalid)}});
  }
}

/**
 * @description  Renders the requested UI accordingly to the information given.
 * @param {string} ui
 * @param {string} html
 * @param {string} err
*/
userController.prototype.renderUI=function(ui,html,err){
  if(err) return LOG(err);
  return this.socket.emit("update ui",this.update_ui[ui],html);
}

/**
 * @description Retrieve the users permissiontree and establish the overriding permissions etc.
 * @returns {array}
 */
userController.prototype.getPermissionsTree=function(){
  if(!this.groups||!this.groups.length) return;
  this.permissionsTree={};
  for(var i=0;i<this.groups.length;i++){
    for(var keys in permissionGroups[this.groups[i].toString()].permissions){
      if(this.permissionsTree[keys]){
        if(this.permissionsTree[keys]<permissionGroups[this.groups[i].toString()].permissions[keys]){
          this.permissionsTree[keys]=permissionGroups[this.groups[i].toString()].permissions[keys];
        }
      }else{
        this.permissionsTree[keys]=permissionGroups[this.groups[i].toString()].permissions[keys];
      }
    }
  }
  this.applyPermissionsTree();
  return this.permissionsTree;
}

/**
 * @description Appply the permissionstree to the userController and filter through the data as anticipated.
 */
userController.prototype.applyPermissionsTree=function(){
  if(!this.permissionsTree) return;
  this.directories=[];
  this.directories=global.directoryTree.directoriesEx.slice();
  this.directoriesEx={}
  //Apply any initial values if any.
  for(var i=0;i<this.directories.length;i++){
    if(this.permissionsTree[this.directories[i]._id.toString()]){
      this.directories[i].permissions=this.permissionsTree[this.directories[i]._id.toString()];
    }
    this.directoriesEx[this.directories[i]._id.toString()]=this.directories[i];
  }
  //Get categories.
  this.categories=this.directories.filter((val)=>{ return (val.category) });
  this.permissionsTreeIterate(this.categories);
}

/**
 * @description Internal part of the permission calculation system.
 * @param {function} next
 */
userController.prototype.permissionsTreeIterate=function(next){
  for(var i=0;i<next.length;i++){
    this.permissionsDecide(next[i]);
    if(!next[i].children||!next[i].children.length) continue;
    this.permissionsTreeIterate(next[i].children);
  }
}

/**
 * @description Internal part of the permission calculation system.
 * @param {function} next
 */
userController.prototype.permissionsDecide=function(next){
  if(!this.permissionsTree) return;
  if(this.permissionsTree[next._id.toString()]){
    next.permissions=this.permissionsTree[next._id.toString()];
  }else{ //Simple iteration right now. This could be improved a little bit in the future but it seems to work fine for now.
    if(next.parent&&this.directoriesEx[next.parent]){
      if(this.directoriesEx[next.parent].permissions){
        next.permissions=this.directoriesEx[next.parent].permissions;
      }else{
        next.permissions=this.permissionsTree.default;
      }
    }else{
      next.permissions=this.permissionsTree.default;
    }
  }
}

/**
 * @description Currently all it does is filter out the directories with not proper read permissions on a per user-basis.
 * @param {array} array
*/
//Somewhat temporary although I think it should be at user level that the permissions are applied to whatever output.
//Need to have some sort of parental map made, applying the permission value to each group, if it doesn't have a value, take its parents, so forth. This should be done in getPermissionsTree.
//Only for directories of course, doing it for all discussions and comments and users would be unreasonable.
userController.prototype.permissionFilter=function(array){
  if(!this.permissionsTree||!array||!array.length) return array;
  for(var i=array.length-1;i>=0;i--){
    var perms=this.permissionsTree.default;
    if(this.permissionsTree[array[i]._id.toString()]) perms=this.permissionsTree[array[i]._id.toString()];
    if(!hasPermission("READ",perms)){ array.splice(i,1);}
    if(array[i].children){ array[i].children=this.permissionFilter(array[i].children);  }
    if(i==0) return array;
  }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//---------------------------------------discussions Tree-------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
/**
 * @description Creates a discussion tree object according to the information, will need a discussion obj from database typically.
 * @param {object} discussion 
 * @param {object} config 
 */
function discussionTree(discussion,config={}){
  if(!discussion||!discussion._id) return;
  this.discussion=discussion;
  //config.next -> function that will be emitted once done. Will return the directoryTree.
  if(config.next) this.next=config.next;
  //config.origin -> can contain first sorting parameter function for filter if wished to load from something else than upper view, for example a child directory.
  if(config.origin) this.origin=config.origin;
  //Contains object with keys containing ids and a default. The permissions from other than default will overrule.
  if(config.permissions) this.permissions=config.permissions;
  this.startTime=Date.now();
  this.pending=0;
  this.getComments(this.origin);
  this.retrieveUser(this.discussion);
  return this;
}

/**
 * @description Retrieve the comments from the discussion inside active database.
 * @param {function} varx
 */
discussionTree.prototype.getComments=function(varx=function(obj,index,array){ return (!obj.directory); }){
  getCollectionArray("discussions",(res)=>{
    this.comments=res;
    if(!this.comments.length) return this.pendingF();
    this.commentsArray=this.comments.filter(varx);
    this.pendingF(this.commentsArray.length);
    for(var i=0;i<this.commentsArray.length;i++){
      if(this.commentsArray[i].author){ this.retrieveUser(this.commentsArray[i]); } //Retrieve minimal data about author.
      this.commentsArray[i].children=this.comments.filter((obj,index,array)=>{ 
        if(!obj.parent) return false;
        return (obj.parent.toString()==this.commentsArray[i]._id.toString());
      });
      this.pendingF();
    }
  },{findBy:{discussion:this.discussion._id}});
}

/**
 * @todo Figure out a better approach to this preferably. I feel like this will be a cumbersome way of handling it, like if loading a large discussion thread, the amount of users to retrieve might cause issues.
 * @description Retrieves user from database according to comment, to retrieve their up to date information.
 * @param {object} comment
 */
discussionTree.prototype.retrieveUser=function(comment){
  this.pendingF(1);
  getCollectionArray("users",(res)=>{
    if(!res||!res.length) return; //@todo handle.
    comment.author=res[0];
    this.pendingF();
  },{findBy:{_id:ObjectId(comment.author)}});
}
discussionTree.prototype.permissionFilter=function(array){
  if(this.permissions&&array.length){
    for(var i=array.length-1;i>=0;i--){
      var perms=this.permissions.default;
      if(this.permissions[array[i]._id.toString()]) perms=this.permissions[array[i]._id.toString()];
      if(!hasPermission("READ",perms)){ array.splice(i,1);}
      if(i==0) return array;
    }
  }else return array;
}
discussionTree.prototype.pendingF=function(increase=-1){
  this.pending+=increase;
  if(this.pending>0) return; //@todo handle.
  LOG("Time taken loading discussionTree:",(Date.now()-this.startTime));
  if(this.next) this.next(this);
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//----------------------------------------directory Tree--------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
function directoryTree(config={}){
  this.startTime=Date.now();
  this.pending=0;
  getCollectionArray("directories",(rex)=>{
    if(!rex||!rex.length) return;
    this.directories={};
    this.directoriesEx=rex;
    this.categories=rex.filter((val,index,array)=>{ return val.category; });
    for(var i=0;i<rex.length;i++){
      this.directories[rex[i]._id.toString()]=rex[i];
      this.getDiscussions(this.directories[rex[i]._id.toString()]);
    }
  });
  return this;
}
directoryTree.prototype.getDiscussions=function(directory){
  this.pendingF(1);
  getCollectionArray("discussions",(res)=>{
    this.directories[directory._id.toString()].discussions=res; //Seperate this from directoryTree function maybe. Only find latest but except for that fuck it, we should perform this seperately when needed.
    this.pendingF();
    if(directory.category){ this.getChildren(directory); }else{ this.findLatestDiscussion(directory); }
  },{findBy:{directory:directory._id},sortBy:{created:-1},limit:50});
}
directoryTree.prototype.getChildren=function(category){
  this.pendingF(1)
  var children=this.directoriesEx.filter(function(obj,index,array){ return (obj.parent==category._id.toString()); }); //@tostringremove
  if(children&&children.length){
    category.children=children;
    this.pendingF(category.children.length);
    for(var i=0;i<category.children.length;i++){
      this.getChildren(category.children[i]);
      this.pendingF();
    }
  }
  this.pendingF();
}
directoryTree.prototype.retrieveUser=function(comment){
  this.pendingF(1);
  getCollectionArray("users",(res)=>{
    if(!res||!res.length) return; //@todo handle
    comment.author=res[0];
    this.pendingF();
  },{findBy:{_id:comment.author}});
}
directoryTree.prototype.findLatestDiscussion=function(directory){
  console.log(directory.discussions);
  if(!directory||!directory.discussions||!directory.discussions[0]) return this;
  this.pendingF(1);
  directory.latest=directory.discussions[0];
  getCollectionArray("discussions",(res2)=>{
    if(res2&&res2.length&&!moment(directory.discussions[0].created).isSameOrAfter(res2[0].created)){ directory.latest.author=res2[0].author; }
    this.retrieveUser(directory.latest);
    this.pendingF();
  },{findBy:{discussion:directory.latest._id},sortBy:{created:-1},limit:1});
}
directoryTree.prototype.pendingF=function(increase=-1){
  this.pending+=increase;
  if(!this.pending){
    LOG("Time taken loading directoryTree:",(Date.now()-this.startTime));
    if(this.next) this.next(this);
  }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//----------------------------------------originController------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
/**
 * @todo Should be able to support discussions/I kinda think it does already??
 * @description Used to create the backlink from current directory.
 * @param {string} id 
 * @param {function} next 
 * @param {object} config 
 */
function originController(id,next,config={}){
  if(!id||id.length=="") return next([]);
  if(id.includes("/create")){ id=id.replace("/create",""); }
  if(id.length!=24) return next([]);
  this.next=next;
  this.endArray=[];
  getCollectionArray("discussions",(disc)=>{
    if(disc.length){
      this.endArray.unshift(disc[0]);
      id=disc[0].directory;
    }
    this.directories=global.directoryTree.directoriesEx.slice();
    this.testX(id);
  },{findBy:{_id:ObjectId(id)}});
}
/**
 * @description Used for above function constructor, handles the processing basically.
 * @param {ObjectID} id
 */
originController.prototype.testX=function(id){
  for(var i=0;i<this.directories.length;i++){
    if(this.directories[i]._id.toString()!=id.toString()) continue;
    this.endArray.unshift(this.directories[i]);
    if(!this.directories[i].parent) return this.next(this.endArray);
    this.testX(ObjectId(this.directories[i].parent));
    this.directories.splice(i,1);
    return;
  }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//----------------------------------------Express Routing-------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
//First loaded after everything else is loaded.
function loadRoutes(){
  app.get(["/","/login","/register"],normalRoute);
  app.get("/logout",(req,res)=>{
    req.session.destroy(function(err){ if(err) return LOG(err); });
    return res.redirect("/");
  });
  app.get("/:id/create",(req,res)=>{
    if(!req.params.id||req.params.id.length!=12&&req.params.id.length!=24) return res.redirect("/");
    if(!global.directoryTree.directories[req.params.id]) res.redirect("/");
    return res.render("createDiscussion",{session:req.session,params:req.params});
  });
  app.get("/:id",(req,res)=>{
    if(!req.params.id||req.params.id.length!=12&&req.params.id.length!=24) return res.redirect("/");
    if(global.directoryTree.directories[req.params.id]) return res.render("directory",{session:req.session});
    getCollectionArray("discussions",(disc)=>{
      if(!disc.length) return res.redirect("/"); 
      return res.render("discussion",{session:req.session});
    },{findBy:{_id:ObjectId(req.params.id)}});
  });
  app.get("/*",(req,res)=>res.redirect("/"));
  http.listen(80);
}

function normalRoute(req,res){
  var url="landing";
  if(req.path.length>=2) url=req.path.substring(1);
  return res.render(url,{session:req.session});
}