const http=require("http");
const P=process.argv[2]||4789;
function api(m,p,b){return new Promise((y,n)=>{const o={hostname:"127.0.0.1",port:P,path:p,method:m,headers:{"Content-Type":"application/json"}};const r=http.request(o,res=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{y({s:res.statusCode,b:JSON.parse(d)})}catch(e){y({s:res.statusCode,b:d})}});});r.on("error",n);if(b)r.write(JSON.stringify(b));r.end();});}
function rnd(a,b){return Math.random()*(b-a)+a;}
function pick(a){return a[Math.floor(Math.random()*a.length)];}

const links=[
  {slug:"promo",destination:"https://store.example.com/summer-sale",label:"Summer Sale Promo",tracking_mode:"redirect"},
  {slug:"flyer",destination:"https://events.example.com/food-fest",label:"Food Festival Flyer",tracking_mode:"redirect"},
  {slug:"agent",destination:"https://listings.example.com/123-main-st",label:"123 Main St Listing",tracking_mode:"embed",gps_interval:15,max_pings:200},
  {slug:"tour",destination:"https://tour.example.com/downtown-walk",label:"Downtown Walking Tour",tracking_mode:"embed",gps_interval:10,max_pings:500},
  {slug:"sms1",destination:"https://campaign.example.com/sms-optin",label:"SMS Opt-in Page",tracking_mode:"redirect"},
  {slug:"qr1",destination:"https://menu.example.com",label:"Restaurant QR Menu",tracking_mode:"redirect"},
  {slug:"open",destination:"https://realestate.example.com/open-house",label:"Open House Saturday",tracking_mode:"embed",gps_interval:20,max_pings:100},
  {slug:"ad1",destination:"https://ads.example.com/billboard-track",label:"Billboard Campaign",tracking_mode:"redirect"},
];

const cities=[
  {city:"Phoenix",region:"Arizona",country:"US",lat:33.45,lon:-112.07},
  {city:"Scottsdale",region:"Arizona",country:"US",lat:33.49,lon:-111.63},
  {city:"Los Angeles",region:"California",country:"US",lat:34.05,lon:-118.24},
  {city:"San Diego",region:"California",country:"US",lat:32.72,lon:-117.16},
  {city:"Denver",region:"Colorado",country:"US",lat:39.74,lon:-104.99},
  {city:"Austin",region:"Texas",country:"US",lat:30.27,lon:-97.74},
  {city:"Chicago",region:"Illinois",country:"US",lat:41.88,lon:-87.63},
  {city:"New York",region:"New York",country:"US",lat:40.71,lon:-74.01},
  {city:"London",region:"England",country:"GB",lat:51.51,lon:-0.13},
  {city:"Toronto",region:"Ontario",country:"CA",lat:43.65,lon:-79.38},
  {city:"Tokyo",region:"Tokyo",country:"JP",lat:35.68,lon:139.69},
  {city:"Sydney",region:"New South Wales",country:"AU",lat:-33.87,lon:151.21},
];

async function main(){
  console.log("Creating links...");
  for(const l of links){const r=await api("POST","/api/links",l);console.log("  "+l.slug+": "+(r.s===201?"OK":"ERR "+r.b?.error));}

  const counts={promo:87,flyer:42,agent:23,tour:56,sms1:31,qr1:64,open:18,ad1:109};
  console.log("Seeding clicks+pings...");
  for(const [slug,count] of Object.entries(counts)){
    const link=await api("GET","/api/links/"+slug);
    const isEmbed=link.b?.tracking_mode==="embed";
    for(let i=0;i<count;i++){
      const loc=pick(cities);const lat=loc.lat+rnd(-0.02,0.02);const lon=loc.lon+rnd(-0.02,0.02);
      const acc=Math.round(rnd(5,50));const isGps=isEmbed?true:Math.random()>0.3;
      const r=await api("POST","/api/click",{slug,...(isGps?{gps_lat:lat,gps_lon:lon,gps_accuracy:acc}:{})});
      if(isEmbed&&r.b?.click_id&&Math.random()>0.2){
        const n=Math.floor(rnd(2,9));let pl=lat,po=lon;
        for(let j=0;j<n;j++){pl+=rnd(-0.003,0.003);po+=rnd(-0.003,0.003);await api("POST","/api/ping",{click_id:r.b.click_id,lat:pl,lon:po,accuracy:Math.round(rnd(3,30))});}
      }
    }
    console.log("  "+slug+": "+count+" clicks");
  }

  const all=await api("GET","/api/links");
  let tc=0,tp=0;
  for(const l of all.b){const d=await api("GET","/api/links/"+l.slug);tc+=d.b?.stats?.total||0;tp+=d.b?.location_pings?.length||0;}
  console.log("\n✅ Done:",all.b.length,"links,",tc,"clicks,",tp,"pings");
}
main().catch(e=>console.error(e));
