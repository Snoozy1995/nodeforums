module.exports=function(global){
    this._client=require("mongodb").MongoClient;
    //this.global=global;
    this.db;
    this.dboriginal;
    this.connect=function(){
        this._client.connect('mongodb://'+global.config.mongoIP+':'+global.config.mongoPort+'/?maxPoolSize=1', function(err, db) {
            if (err) throw err;
            global.dboriginal=db;
            this.dboriginal=db;
            global.db = db.db(global.config.mongoDB);
            this.db=db.db(global.config.mongoDB);
            global.db.on('close',()=>this.connect());

            //This code should be seperated into another file. This mongo.js file should be exclusively for database specific stuff, not stuff in conjugation with forum data actions.
            loadRoutes(); //Hmpf?
            this.get("permission_groups",(res)=>{
                for(var i=0;i<res.length;i++){
                    var permGroup=new permissionGroup(res[i]);
                    permissionGroups[res[i]._id.toString()]=permGroup;
                    permissionGroupsArray.push(permGroup);
                }
            });
            this.get("discussions",(resx)=>{
                global.discussions=resx;
            },{findBy:{directory:{$exists:true}},count:true});
            global.directoryTree=new directoryTree();
        });
    }
    this.get=function(collection,next,options={}){
        if(!collection||!next||!this.db) return;
        var res=this.db.collection(collection).find(options.findBy);
        if(options.sortBy){ res.sort(options.sortBy); }
        if(options.limit){ res.limit(options.limit); }
        if(options.count) return res.count((e,r)=>this._handle(e,r,next));
        return res.toArray((err, res)=>this._handle(err,res,next));
    }
    this.insert=function(collection,insert,next){
        if(!collection||!insert||!next||!this.db) return;
        if(insert instanceof Object) return this.db.collection(collection).insertOne(insert,(err, res)=>this._handle(err,res,next));
        if(insert.constructor instanceof Array) return this.db.collection(collection).insertMany(insert,(err, res)=>this._handle(err,res,next));
        return true;
    }
    this._handle=function(){
        if (err) throw err;
        if(next) return next(res);
        return true;
    }
    this.connect();
    return this;
}