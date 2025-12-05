const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const port = process.env.PORT || 3000;
const crypto = require("crypto");
const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-firebase-adminsdk.json");
const { create } = require("domain");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = "PRCL";
  const data = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${data}-${random}`;
}

// middleware
app.use(express.json());
app.use(cors());
const verifyFBToken = async (req, res, next) => {
  // console.log('headers in the middleware', req.headers?.authorization)
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    // console.log('decoded in the token', decoded)
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.w0nmtjl.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("zap_shift_db");
    const userCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");
    const trackingsCollection = db.collection("trackings");

    // middle admin before allowing admin activity
    // must be used after verifyFBToken middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    const verifyRider = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    // tracking function
    const logTracking = async(trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split('_').join(' '),
        createdAt: new Date()
      }
      const result = await trackingsCollection.insertOne(log)
      return result
    }



    // user related apis
    app.get("/users", async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        // query.displayName = {$regex: searchText, $options: 'i'}
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
          { role: { $regex: searchText, $options: "i" } },
        ];
      }

      const cursor = userCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(20);
      const result = await cursor.toArray();
      res.send(result);
    });

    // user role
    app.get("/users/:id", async (req, res) => {});

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.post("/users", verifyFBToken, async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();

      const email = user.email;
      const userExist = await userCollection.findOne({ email });
      if (userExist) {
        return res.send({ message: "user exist" });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            role: roleInfo.role,
          },
        };
        const result = await userCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    // parcels related api
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      if (email) {
        query.senderEmail = email;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { sort: { createdAt: -1 } };

      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }

      if (deliveryStatus) {
        // query.deliveryStatus = {$in: ['driver_assigned', 'rider_arriving']};
        query.deliveryStatus = { $nin: ["parcel_delivered"] };
      }

      const cursor = parcelsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.get('/parcels/deliveryStatus/stat', async (req, res) =>{
      const pipeline = [
        {
          $group:{
            _id: '$deliveryStatus',
            count: {$sum: 1}
          }
        },
        {
          $project:{
              status: '$_id',
              count: {$sum: 1}
              // _id: 0
          }
        }
      ]
      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result)
    })


    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const trackingId = generateTrackingId();
      // parcel created time
      parcel.createdAt = new Date();
      parcel.trackingId = trackingId;
      logTracking(trackingId, 'parcel_created')
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    // Todo: rename this to be specific like /parcels/:id/assign
    app.patch("/parcels/:id", async (req, res) => {
      const { riderId, riderEmail, riderName, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          deliveryStatus: "driver_assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };
      const result = await parcelsCollection.updateOne(query, updateDoc);

      // update rider information
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: "in_delivery",
        },
      };
      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        riderUpdatedDoc
      );

      // log tracking
      logTracking(trackingId, "driver_assigned")

      res.send({
        parcelUpdate: result,
        riderUpdate: riderResult,
      });
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const { deliveryStatus, riderId, trackingId } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updatedDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };

      if(deliveryStatus === 'parcel_delivered'){
        // update rider information
        const riderQuery = {_id: new ObjectId(riderId)}
        const riderUpdatedDoc = {
          $set:{
            workStatus: 'available'
          }
        }
        const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdatedDoc)
      }

      const result = await parcelsCollection.updateOne(query, updatedDoc);
      // log tracking
      logTracking(trackingId, deliveryStatus)
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });


    // payment related apis
    app.post("/payment-checkout-session", async (req, res) => {
      const parcelInfo = req.body;
      const amount = parseInt(parcelInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `Please pay for: ${parcelInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          parcelId: parcelInfo.parcelId,
          parcelName: parcelInfo.parcelName,
          trackingId: parcelInfo.trackingId
        },
        customer_email: parcelInfo.senderEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-canceled`,
      });
      res.send({ url: session.url });
    });

    // old
    // app.post("/create-checkout-session", async (req, res) => {
    //   const parcelInfo = req.body;
    //   const amount = parseInt(parcelInfo.cost) * 100;
    //   const session = await stripe.checkout.sessions.create({
    //     line_items: [
    //       {
    //         price_data: {
    //           currency: "USD",
    //           unit_amount: amount,
    //           product_data: {
    //             name: parcelInfo.parcelName,
    //           },
    //         },
    //         quantity: 1,
    //       },
    //     ],
    //     customer_email: parcelInfo.senderEmail,
    //     mode: "payment",
    //     metadata: {
    //       parcelId: parcelInfo.parcelId,
    //     },
    //     success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
    //     cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-canceled`,
    //   });
    //   console.log(session);
    //   res.send({ url: session.url });
    // });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      // console.log('session id', sessionId)
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // console.log("retrieve", session);
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);
      if (paymentExist) {
        return res.send({
          message: "already exist",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      // use the previous tracking id created during the parcel create which was set to the session metadata during session creation
      const trackingId = session.metadata.trackingId;

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
          },
        };
        const result = await parcelsCollection.updateOne(query, update);

        const paymentIdentify = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };
        
          const resultPayment = await paymentCollection.insertOne(
            paymentIdentify
          );

          logTracking(trackingId, "parcel_paid")

          return res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            parcelInfo: resultPayment,
          });
                // res.send(result)
      }

      return res.send({ success: false });
    });

    // get payment history
    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      // console.log('headers', req.headers)

      if (email) {
        query.customerEmail = email;

        // check email address
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // riders related apis
    // app.get("/riders", async (req, res) => {
    //   const { status, riderDistrict, workStatus } = req.query;

    //   const query = {};

    //   if (status) {
    //     query.status = status;
    //   }

    //   if (riderDistrict) {
    //     query.riderDistrict = riderDistrict;
    //   }

    //   if (workStatus) {
    //     query.workStatus = workStatus;
    //   }

    //   const cursor = ridersCollection.find(query);
    //   const result = await cursor.toArray();
    //   res.send(result);
    // });

    app.get("/riders", async (req, res) => {
      const { status, riderDistrict, workStatus } = req.query;

      const matchStage = {};

      if (status) matchStage.status = status;
      if (riderDistrict) matchStage.riderDistrict = riderDistrict;
      if (workStatus) matchStage.workStatus = workStatus;

      const pipeline = [
        { $match: matchStage },

        {
          $lookup: {
            from: "users",
            localField: "riderEmail",
            foreignField: "email",
            as: "userInfo",
          },
        },
        {
          $unwind: {
            path: "$userInfo",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $addFields: {
            role: "$userInfo.role",
          },
        },
      ];

      const result = await ridersCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.get('/riders/delivery-per-day', async(req, res)=>{
      const email = req.query.email;
      // aggregate on parcel
      const pipeline = [
        {
          $match: {
            riderEmail: email,
            deliveryStatus: "parcel_delivered"
          }
        },
        {
          $lookup: {
              from:'trackings',
              localField: 'trackingId',
              foreignField: 'trackingId',
              as: 'parcel_trackings'
          }
        },
        {
          $unwind: '$parcel_trackings'
        },
        {
          $match: {
            "parcel_trackings.status": "parcel_delivered"
          }
        },
        {
          // convert timestamp to YYY-MM-DD string
          $addFields:{
            deliveryDay:{
              $dateToString:{
                format: "%Y-%m-%d",
                date: "$parcel_trackings.createdAt"
              }
            }
          }
        },
        {
          // group by date
          $group: {
            _id: "$deliveryDay",
            deliveredCount: {$sum: 1}
          }
        },
       
      ];
      const result = await parcelsCollection.aggregate(pipeline).toArray()
      res.send(result)
    })

    // app.post("/riders", async (req, res) => {
    //   const rider = req.body;
    //   rider.status = "Pending";
    //   rider.createdAt = new Date();

    //   const result = await ridersCollection.insertOne(rider);
    //   res.send(result);
    // });

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "Pending";
      rider.role = "rider"; // ADD THIS
      rider.createdAt = new Date();

      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: status,
          workStatus: "available",
        },
      };
      const result = await ridersCollection.updateOne(query, updateDoc);

      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await userCollection.updateOne(
          userQuery,
          updateUser
        );
      }

      res.send(result);
    });

    app.delete("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await ridersCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });


    // tracking related api
    app.get('/trackings/:trackingId/logs', async(req, res) =>{
      const trackingId = req.params.trackingId;
      const query = { trackingId }
      const result = await trackingsCollection.find(query).toArray();
      res.send(result)
    })



    // ping
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
  }
}
run().catch(console.dir);
