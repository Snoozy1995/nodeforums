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
const   fs              = require("fs");
var sharedsession = require("express-socket.io-session");
var global={},clients=[];
var MongoClient = require('mongodb').MongoClient;
var dburl = "mongodb://localhost:27017/?maxPoolSize=1";
var dbname="nodeforum";
var store = new MongoDBStore({uri:'mongodb://localhost:27017/',databaseName:dbname,collection: 'web_sessions'});
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

// APP ROUTING
app.use(compression());
app.use(session1);
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'pug');
io.use(sharedsession(session1));

//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//---------------------------------------MongoDB functions------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
function connectToMongo(first=false){
  MongoClient.connect(dburl, function(err, db) {
    if (err) throw err;
    global.dboriginal=db;
    global.db = db.db(dbname);
    global.db.on('close',()=>{
      console.log("[MONGODB][ERROR]: connection closed");
      connectToMongo();
    });
    loadRoutes();
    console.log(res);
  });
}
function getCollectionArray(collection,next,sortby={}){
  if(!collection||!next||!global||!global.db) return;
  global.db.collection(collection).find(sortby).toArray(function(err, res) {
    if (err) throw err;
    if(next) return next(res);
  });
}
function insertDocument(target,insert,next){
  if(insert instanceof Object){
    global.db.collection(target).insertOne(insert,(err, res)=>{
      if (err) throw err;
      if(next) return next(res);
    });
  }else if(insert.constructor instanceof Array){
    global.db.collection(target).insertMany(insert,(err, res)=>{
      if (err) throw err;
      if(next) return next(res);
    });
  }
}

connectToMongo(true);

//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//-------------------------------------PERMISSION FUNCTIONS-----------------------------------------//
//--------------------------------------------------------------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
const PERMISSIONS={
  READ:0x1,
  WRITE:0x2,
  MANAGE_MESSAGES:0x4,
  ADMINISTRATOR:0x8
};

function hasPermission(permission,permissions){
  if(typeof permission=="number") return ((permissions&permission)==permission)
  else if(!typeof permission=="string") return false;
  if(!PERMISSIONS[permission]) return;
  return ((permissions&PERMISSIONS[permission])==PERMISSIONS[permission])
}

function permissionGroup(){
  this.name;
  this.permissions;
  this._id;
  this.color;
  this.order;
  return this;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
//--------------------------------------------------------------------------------------------------//
//---------------------------------------user Controller--------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//--------------------------------------------------------------------------------------------------//
//////////////////////////////////////////////////////////////////////////////////////////////////////
io.on("connection",(socket)=>clients.push(new userController(socket)));
function userController(socket){
  this.socket=socket;

  this.socket.on("login",(username,password)=>{
    getCollectionArray("users",(res)=>{
      if(!res.length) return; //Return socket.io error response
      this.logged=true;
      this.document=res[0];
      return; //Logged in
    },{username:username,password:password})
  });
  this.socket.on("register",(username,password,email)=>{

  });

  //Permission groups*
  //Permissions*
  //*to be implemented

  this.update_ui={};
  this.update_pending={};
  this.socket.on("register ui",(ui,target)=>{
    this.update_ui[ui]=target;
    if(!this.updateUI(ui)) return;
  });
  this.socket.on("disconnect",()=>{
    console.log("socket disconnected");
    clients.splice(this,1);
  });
}
userController.prototype.updateUI=function(ui){
  var res=this;
  switch(ui){
    case "directoryView":
      return getCollectionArray("directories",(directories)=>{
        new directoryTree(directories,{
          next:(that)=>app.render("api/"+ui,{directories:that.directories},(err,html)=>res.renderUI(ui,html,err))
        });
      });
    case "childView":
      return getCollectionArray("directories",(directories)=>{
        new directoryTree(directories,{
          next:(that)=>app.render("api/"+ui,that,(err,html)=>res.renderUI(ui,html,err)),
          loadDiscussions:true,
          origin:(obj,index,array)=>{ return (obj._id.toString()==res.socket.handshake.query.id); }
        }); 
      });
    case "railProfileView":
      return app.render("api/"+ui,(err,html)=>res.renderUI(ui,html,err));
  }
}
userController.prototype.renderUI=function(ui,html,err){
  if(err) return console.log(err);
  return this.socket.emit("update ui",this.update_ui[ui],html);
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
  this.startTime=Date.now();
  this.pending=0;
  this.getDirectories(this.origin);
  return this;
}
directoryTree.prototype.getDirectories=function(varx=function(obj,index,array){ return (obj.category); }){
  this.directories=this.directoriesX.filter(varx);
  this.pendingF(this.directories.length);
  for(var i=0;i<this.directories.length;i++){ 
    if(this.loadDiscussions){
      this.pendingF(1);
      getCollectionArray("discussions",(res)=>{
        this.discussions=res;
        this.pendingF();
      },{directory:this.directories[i]._id.toString()});
    }
    this.getChildren(this.directories[i]); 
  }
}
directoryTree.prototype.getChildren=function(category){
  var children=this.directoriesX.filter(function(obj,index,array){
    return (obj.parent==category._id.toString()); 
  });
  category.children=children;
  if(category.children.length){
    this.pendingF(category.children.length);
    for(var i=0;i<category.children.length;i++){
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
function originController(id,next){
  this.next=next;
  this.endArray=[];
  getCollectionArray("directories",(directories)=>{
    this.directories=directories;
    this.testX(id);
  });
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
  app.get("/createDiscussion*",(req,res)=>{
    if(!req.query.id||req.query.id.length!=12&&req.query.id.length!=24) return res.redirect("/");
    getCollectionArray("directories",(directories)=>{
      if(!directories.length) return res.redirect("/");
      new originController(directories[0]._id,(r)=>{
        return res.render("directory",{query:req.query,origin:r});
      });
    },{_id:ObjectId(req.query.id)});
  });
  app.get(["/login","/register","/"],normalRoute);
  app.get(["/:id"],(req,res)=>{
    if(!req.params.id||req.params.id.length!=12&&req.params.id.length!=24) return res.redirect("/");
    getCollectionArray("directories",(directories)=>{
      if(!directories.length) return;
      new originController(directories[0]._id,(r)=>{
        return res.render("directory",{query:req.query,origin:r});
      });
    },{_id:ObjectId(req.params.id)});
    getCollectionArray("discussions",(disc)=>{
      if(!disc.length) return;
      new originController(disc[0]._id,(r)=>{
        return res.render("discussion",{query:req.query,origin:r});
      });
    },{_id:ObjectId(req.params.id)});
  });
  app.get("/*",(req,res)=>res.redirect("/"));
  http.listen(80);
}

function normalRoute(req,res){
  var url="landing";
  if(req.path.length>=2) url=req.path.substring(1);
  return res.render(url,{query:req.query});
}