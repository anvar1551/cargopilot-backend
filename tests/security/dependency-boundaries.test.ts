import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";

// No application configuration, dotenv, Prisma, real credentials or network handler is imported.
it("rejects boolean-false body schema before the handler", async () => {
  const app=Fastify({logger:false});const write=jest.fn();
  try {
    app.post("/denied",{schema:{body:false}},async()=>{write();return {ok:true};});
    const response=await app.inject({method:"POST",url:"/denied",payload:{synthetic:true}});
    expect(response.statusCode).toBe(400);expect(write).not.toHaveBeenCalled();
  } finally {await app.close();}
});
it("normalizes required header schema casing and rejects invalid values", async () => {
  const app=Fastify({logger:false});const write=jest.fn();
  try {
    app.post("/header",{schema:{headers:{type:"object",properties:{"X-Guard":{const:"approved"}},required:["X-Guard"]}}},async()=>{write();return {ok:true};});
    expect((await app.inject({method:"POST",url:"/header",headers:{"x-guard":"wrong"}})).statusCode).toBe(400);
    expect(write).not.toHaveBeenCalled();
    expect((await app.inject({method:"POST",url:"/header",headers:{"x-guard":"approved"}})).statusCode).toBe(200);
    expect(write).toHaveBeenCalledTimes(1);
  } finally {await app.close();}
});
it("multipart accepts bounded content and rejects oversized content before downstream writes", async () => {
  const app=Fastify({logger:false});const write=jest.fn();
  try {
    await app.register(multipart,{limits:{files:1,fileSize:32,fields:2,fieldSize:32,parts:3}});
    app.post("/file",async request=>{const file=await request.file();if(!file)throw Error("No file");await file.toBuffer();write();return {ok:true};});
    const request=(body:string)=>({method:"POST" as const,url:"/file",headers:{"content-type":"multipart/form-data; boundary=synthetic-boundary"},payload:'--synthetic-boundary\r\nContent-Disposition: form-data; name="photo"; filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\n'+body+'\r\n--synthetic-boundary--\r\n'});
    expect((await app.inject(request("synthetic"))).statusCode).toBe(200);write.mockClear();
    expect((await app.inject(request("s".repeat(64)))).statusCode).toBe(413);expect(write).not.toHaveBeenCalled();
  } finally {await app.close();}
});
it("actual SDK preserves immutable upload headers and parses synthetic XML through a network-free handler", async () => {
  const seen:any[]=[];
  const handler={handle:async(request:any)=>{seen.push(request);return {response:{statusCode:200,headers:{"content-type":"application/xml"},body:Readable.from([request.method==="GET"?'<?xml version="1.0"?><ListBucketResult><Name>synthetic-owned-bucket</Name><IsTruncated>false</IsTruncated><Contents><Key>synthetic/proof.png</Key><Size>4</Size></Contents></ListBucketResult>':''])}};}};
  const client=new S3Client({region:"us-east-1",endpoint:"https://synthetic-storage.example.invalid",forcePathStyle:true,credentials:{accessKeyId:"SYNTHETIC_TEST_ACCESS",secretAccessKey:"synthetic-test-only"},requestHandler:handler,maxAttempts:1});
  try {
    await client.send(new PutObjectCommand({Bucket:"synthetic-owned-bucket",Key:"synthetic/proof.png",Body:Buffer.from("test"),IfNoneMatch:"*",ContentType:"image/png"}));
    expect(seen[0].headers["if-none-match"]).toBe("*");expect(seen[0].headers["content-type"]).toBe("image/png");
    expect(Object.keys(seen[0].headers).some(key=>key.startsWith("x-amz-checksum-"))).toBe(true);
    const result=await client.send(new ListObjectsV2Command({Bucket:"synthetic-owned-bucket",MaxKeys:1}));
    expect(result.Contents?.map(x=>({key:x.Key,size:x.Size}))).toEqual([{key:"synthetic/proof.png",size:4}]);expect(result.IsTruncated).toBe(false);expect(seen).toHaveLength(2);
    const signed=new URL(await getSignedUrl(client,new GetObjectCommand({Bucket:"synthetic-owned-bucket",Key:"synthetic/proof.png"}),{expiresIn:60}));
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("60");expect(signed.pathname).toBe("/synthetic-owned-bucket/synthetic/proof.png");expect(seen).toHaveLength(2);
  } finally {client.destroy();}
},15000);
