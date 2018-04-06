/*process.on('uncaughtException', function (err) {
console.log(err); //Send some notification about the error
process.exit(1); });*/
//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//-------------------------------------------CONSTANTS----------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
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
const   fs              = require("fs");
const   crypto          = require("crypto");
var sharedsession = require("express-socket.io-session");
var global={},clients=[],permissionGroups={},permissionGroupsArray=[];
var MongoClient = require('mongodb').MongoClient;
var store = new MongoDBStore({uri:'mongodb://'+config.mongoIP+':'+config.mongoPort+'/',databaseName:config.mongoDB,collection: 'web_sessions'});
store.on('error', function(error) { assert.ifError(error); assert.ok(false); });
const session1=session({
  secret: config.session_secret,
  resave: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  },
  saveUninitialized: true,
  store: store
});
app.use(compression());
app.use(session1);
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'pug');
io.use(sharedsession(session1));
function endProcess(err){ console.log(err); process.exit(1); }
if(!config.mongoIP||!config.mongoPort||!config.mongoDB||!config.session_secret||!config.mongoSecret) return endProcess("Configuration file not properly setup. Please refer to config/config.js");
//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//---------------------------------------MongoDB functions------------------------------------------//
//--------------------------------------------------------------------------------------------------//
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
  });
}
connectToMongo();

function getCollectionArray(collection,next,options={}){
  if(!collection||!next||!global||!global.db) return;
  var res=global.db.collection(collection).find(options.findBy);
  if(options.sortBy){ res.sort(options.sortBy); }
  if(options.limit){ res.limit(options.limit); }
  if(options.count){
    res.count((e,r)=>documentHandle(e,r,next));
  }else{
    res.toArray((err, res)=>documentHandle(err,res,next));
  }
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

//Maybe rewrite to use userController.prototype.updateUIALL();
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
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
function is_valid_email(email){ return /^.+@.+\..+$/.test(email); }
io.on("connection",(socket)=>clients.push(new userController(socket)));
function userController(socket){
  this.socket=socket;
  this.session=socket.handshake.session;
  if(this.session&&this.session.logged&&this.session.username){ this.loadUser(this.session.username); }
  this.update_ui={};
  this.socket.on("pong1",()=>console.log("Socket ping: "+(Date.now()-this.pingVal)+"ms"));
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
  this.ping();
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
  if(config.pushstate!=undefined){
    this.pageid=config.pushstate;
    //Should check current url, if same url then dont.*
    this.socket.emit("pushstate","/"+config.pushstate,{ui:ui,target:target,id:this.pageid});
    this.updateUI("originView");
  }
  if(!len){
    this.update_ui[ui]=target;
    this.updateUI(ui);
    return this;
  }
  var i=0;
  for(var obj in this.update_ui){
    i++
    if(this.update_ui[obj]==target&&obj!=ui){ delete this.update_ui[obj]; }
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
    global.discussions++;
    this.socket.emit("redirect","/"+res.insertedId.toString());
    clients_update(directory,"threeStatistics");
    clients_update(directory,"childView");
  });
  return this;
}
userController.prototype.createComment=function(discussion,comment,parent){
  if(!this.hasPermission(PERMISSIONS.WRITE,discussion)) return;
  var insert={discussion:ObjectId(discussion),text:comment,created:moment().format(),author:this.session._id};
  if(parent){ insert.parent=parent; }
  insertDocument("discussions",insert,(res)=>{ clients_update(discussion,"discussionView"); });
  return this;
}
userController.prototype.disconnect=function(){ 
  clients.splice(this,1); 
}
userController.prototype.loadUser=function(username,setSession=false,redirect=false){
  getCollectionArray("users",(res)=>{
    if(!res.length) return this.session.destroy(function(err){ 
      if(err) return console.log(err); 
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
userController.prototype.setSession=function(session={}){
  for(var index in session){ this.session[index]=session[index]; }
  this.session.save();
  return this;
}
userController.prototype.encrypt=function(password){
  if(password.length!=64) return;
  var hash = crypto.createHmac('sha256',config.mongoSecret);
  hash.update(password.substring(16,48));
  return hash.digest('hex');
}
userController.prototype.updateUIALL=function(){
  for(var key in this.update_ui){
    this.updateUI(key);
  }
}
userController.prototype.updateUI=function(ui){
  var res=this;
  switch(ui){
    case "discussionView":
      return getCollectionArray("discussions",(result)=>{
        if(!result.length) return console.log("This should be handled error getting discussionView @ userController.updateUI");
        new discussionTree(result[0],{
          next:(that)=>app.render("api/"+ui,{permissions:res.permissionsTree,session:res.session,discussion:that.discussion,comments:that.commentsArray},(err,html)=>res.renderUI(ui,html,err)),
          //permissions:res.permissionsTree

        });
      },{findBy:{_id:ObjectId(this.pageid)}});
    case "directoryView":
      return getCollectionArray("directories",(directories)=>{
        new directoryTree(directories,{
          next:(that)=>app.render("api/"+ui,{permissions:res.permissionsTree,session:res.session,directories:that.directories},(err,html)=>res.renderUI(ui,html,err)),
          permissions:res.permissionsTree
        });
      });
    case "childView":
      return getCollectionArray("directories",(directories)=>{
        new directoryTree(directories,{
          next:(that)=>app.render("api/"+ui,{permissions:res.permissionsTree,session:res.session,directories:that.directories,discussions:that.discussions},(err,html)=>res.renderUI(ui,html,err)),
          loadDiscussions:true,
          permissions:res.permissionsTree,
          origin:(obj,index,array)=>{ return (obj._id.toString()==res.pageid); }
        }); 
      });
    case "railProfileView": return app.render("api/"+ui,{session:res.session},(err,html)=>res.renderUI(ui,html,err));
    case "threeStatistics": return app.render("api/"+ui,{statistics:{online:clients.length,discussions:global.discussions}},(err,html)=>res.renderUI(ui,html,err));
    case "originView":
      return new originController(this.pageid,(r)=>{
        app.render("api/"+ui,{origin:r},(err,html)=>res.renderUI(ui,html,err));
      });
  }
}
userController.prototype.renderUI=function(ui,html,err){
  if(err) return console.log(err);
  return this.socket.emit("update ui",this.update_ui[ui],html);
}
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
  return this.permissionsTree;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//---------------------------------------discussions Tree-------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
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

discussionTree.prototype.getComments=function(varx=function(obj,index,array){ return (!obj.directory); }){
  getCollectionArray("discussions",(res)=>{
    this.comments=res;
    if(!this.comments.length) return this.pendingF();
    this.commentsArray=this.comments.filter(varx);
    this.pendingF(this.commentsArray.length);
    for(var i=0;i<this.commentsArray.length;i++){
      if(this.commentsArray[i].author){
        this.retrieveUser(this.commentsArray[i]);
        //Retrieve minimal data about author.
      }
      this.commentsArray[i].children=this.comments.filter((obj,index,array)=>{ 
        if(!obj.parent) return false;
        return (obj.parent.toString()==this.commentsArray[i]._id.toString());
      });
      this.pendingF();
    }

  },{findBy:{discussion:this.discussion._id}});
}
discussionTree.prototype.retrieveUser=function(comment){
  this.pendingF(1);
  getCollectionArray("users",(res)=>{
    if(res&&res.length){
      comment.author=res[0];
      this.pendingF();
    }
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
  if(this.pending<=0){
    console.log("Time taken loading discussionTree:",(Date.now()-this.startTime));
    if(this.next) this.next(this);
  }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//----------------------------------------directory Tree--------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
function directoryTree(directories,config={}){
  if(!directories) return;
  this.directoriesX=directories;
  //config.next -> function that will be emitted once done. Will return the directoryTree.
  if(config.next) this.next=config.next;
  //config.origin -> can contain first sorting parameter function for filter if wished to load from something else than upper view, for example a child directory.
  if(config.origin) this.origin=config.origin;

  if(config.loadDiscussions) this.loadDiscussions=config.loadDiscussions;

  //Contains object with keys containing ids and a default. The permissions from other than default will overrule.
  if(config.permissions) this.permissions=config.permissions;

  this.startTime=Date.now();
  this.pending=0;
  this.getDirectories(this.origin);
  return this;
}
directoryTree.prototype.retrieveUser=function(comment){
  this.pendingF(1);
  getCollectionArray("users",(res)=>{
    if(res&&res.length){
      comment.author=res[0];
      this.pendingF();
    }
  },{findBy:{_id:comment.author}});
}
directoryTree.prototype.getDirectories=function(varx=function(obj,index,array){ return (obj.category); }){
  this.directories=this.permissionFilter(this.directoriesX.filter(varx));
  this.pendingF(this.directories.length);
  for(var i=0;i<this.directories.length;i++){
    if(this.origin) this.findLatestDiscussion(this.directories[i]);
    if(this.loadDiscussions){
      this.pendingF(1);
      getCollectionArray("discussions",(res)=>{
        this.discussions=res;
        this.pendingF();
      },{findBy:{directory:this.directories[i]._id},sortBy:{created:-1}});
    }
    this.getChildren(this.directories[i]); 
  }
}

//Needs some rewriting to support comments too, also needs to compare the latest comment against the latest discussion to see which is newest.
directoryTree.prototype.findLatestDiscussion=function(directory){
  this.pendingF(1);
  getCollectionArray("discussions",(res)=>{
    if(res&&res.length){ directory.latest=res[0]; }
    if(!directory.latest) return this.pendingF();
    getCollectionArray("discussions",(res2)=>{
      if(res2&&res2.length){ directory.latest.author=res2[0].author; this.retrieveUser(directory.latest); }
      else{ this.retrieveUser(directory.latest); }
      this.pendingF();
    },{findBy:{discussion:directory.latest._id},sortBy:{created:-1},limit:1});
  },{findBy:{directory:directory._id},sortBy:{created:-1},limit:1});
}
directoryTree.prototype.permissionFilter=function(array){
  if(this.permissions&&array.length){
    for(var i=array.length-1;i>=0;i--){
      var perms=this.permissions.default;
      if(this.permissions[array[i]._id.toString()]) perms=this.permissions[array[i]._id.toString()];
      if(!hasPermission("READ",perms)){ array.splice(i,1);}
      if(i==0) return array;
    }
  }else return array;
}
directoryTree.prototype.getChildren=function(category){
  var children=this.permissionFilter(this.directoriesX.filter(function(obj,index,array){ return (obj.parent==category._id.toString()); }));
  if(children&&children.length){
    category.children=children;
    this.pendingF(category.children.length);
    for(var i=0;i<category.children.length;i++){
      this.findLatestDiscussion(category.children[i]);
      this.getChildren(category.children[i]);
    }
  }
  this.pendingF();
}
directoryTree.prototype.pendingF=function(increase=-1){
  this.pending+=increase;
  if(!this.pending){
    console.log("Time taken loading directoryTree:",(Date.now()-this.startTime));
    if(this.next) this.next(this);
  }
}


//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//----------------------------------------originController------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
//Used to create the backlink from current directory.
//Should be able to support discussions.
function originController(id,next,config={}){
  if(!id||id.length=="") return next([]);
  if(id.includes("/create")){ id=id.replace("/create",""); }
  this.next=next;
  this.endArray=[];
  getCollectionArray("discussions",(disc)=>{
    if(disc.length){
      this.endArray.unshift(disc[0]);
      id=disc[0].directory;
    }
    getCollectionArray("directories",(directories)=>{
      this.directories=directories;
      this.testX(id);
    });
  },{findBy:{_id:ObjectId(id)}});
}
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
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
//First loaded after everything else is loaded.
function loadRoutes(){
  app.get(["/login","/register","/"],normalRoute);
  app.get("/logout",(req,res)=>{
    req.session.destroy(function(err){ if(err) return console.log(err); });
    return res.redirect("/");
  });
  app.get("/:id/create",(req,res)=>{
    if(!req.params.id||req.params.id.length!=12&&req.params.id.length!=24) return res.redirect("/");
    getCollectionArray("directories",(directories)=>{
      if(!directories.length) return res.redirect("/");
      return res.render("createDiscussion",{session:req.session,params:req.params});
    },{findBy:{_id:ObjectId(req.params.id)}});
  });
  app.get("/:id",(req,res)=>{
    if(!req.params.id||req.params.id.length!=12&&req.params.id.length!=24) return res.redirect("/");
    getCollectionArray("directories",(directories)=>{
      if(!directories.length) return;
      return res.render("directory",{session:req.session,query:req.query});
    },{findBy:{_id:ObjectId(req.params.id)}});
    getCollectionArray("discussions",(disc)=>{
      if(!disc.length) return;
      return res.render("discussion",{session:req.session,query:req.query});
    },{findBy:{_id:ObjectId(req.params.id)}});
  });
  app.get("/*",(req,res)=>res.redirect("/"));
  http.listen(80);
}

function normalRoute(req,res){
  var url="landing";
  if(req.path.length>=2) url=req.path.substring(1);
  return res.render(url,{session:req.session,query:req.query});
}