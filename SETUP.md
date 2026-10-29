# ตั้งค่าหลังบ้าน (Express บน Netlify) ทำได้จากแท็บเล็ตทั้งหมด

## 1) Google Cloud (console.cloud.google.com)
1. สร้างโปรเจกต์ > APIs & Services > Library > เปิด **Google Sheets API**
2. IAM & Admin > Service Accounts > สร้างบัญชี `money-api` แล้วจดอีเมล
3. เข้าบัญชีนั้น > Keys > Add key > JSON (เก็บเป็นความลับ ใช้เสร็จให้ลบไฟล์ออกจากเครื่อง)
4. OAuth consent screen ตั้งค่าแอป > Credentials > Create OAuth client ID ชนิด **Web application** จดค่า Client ID (ระยะที่ 2 จะใส่โดเมน Netlify ของคุณตรงนี้)

## 2) Google Sheets
สร้างชีตว่าง แล้วกด Share เพิ่มอีเมล service account เป็น **Editor** เท่านั้น (ห้ามแชร์ให้คนอื่นหรือตั้ง "ทุกคนที่มีลิงก์") คัดลอกรหัสชีตจาก URL (ระหว่าง /d/ กับ /edit)

## 3) GitHub + Netlify
1. สร้าง repository ส่วนตัวบน github.com แล้วอัปโหลดทั้งโฟลเดอร์ `money-app` (ผ่านปุ่ม Add file > Upload files ได้) **ห้ามอัปโหลดไฟล์ JSON ของ service account**
2. netlify.com > Add new site > Import from Git > เลือก repo (ค่า build ใช้ตาม `netlify.toml` อัตโนมัติ)
3. Site configuration > Environment variables เพิ่มค่าต่อไปนี้
   - `GOOGLE_CLIENT_ID` = Client ID ข้อ 1.4
   - `SA_EMAIL` = อีเมล service account
   - `SA_KEY` = ค่า `private_key` จากไฟล์ JSON ทั้งก้อน (ตั้งแต่ -----BEGIN ถึง END-----)
   - `SHEET_ID` = รหัสชีต
   - `ADMIN_KEY` = รหัสยาวๆ ที่คุณตั้งเอง
   - `PRO_EMAILS` = อีเมลที่ให้สิทธิ์ Pro ด้วยมือ คั่นด้วยจุลภาค (เว้นว่างได้)
4. Deploys > Trigger deploy เพื่อให้ค่าใหม่มีผล

## 4) สร้างตารางในชีตอัตโนมัติ
ใช้ hoppscotch.io: Method **POST** URL `https://<ชื่อเว็บคุณ>.netlify.app/api/init` เพิ่ม Header `x-admin-key` = ADMIN_KEY แล้วกด Send ต้องได้ `{"ok":true,...}` และชีตจะมี 7 แท็บ

## API (ระยะที่ 2 เรียกใช้) ทุกเส้นต้องมี `Authorization: Bearer <Google ID token>`
GET `/api/load` · POST `/api/consent` `/api/tx` `/api/pot` `/api/budget` `/api/debt` `/api/group/create` `/api/group/invite` `/api/account/delete`
