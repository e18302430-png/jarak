-- جارك: قاعدة البيانات
create table if not exists settings (
  key text primary key,
  value jsonb not null
);

-- العملاء
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null,
  name text,
  created_at timestamptz not null default now()
);
create table if not exists addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  label text not null default 'البيت',
  lat double precision not null,
  lng double precision not null,
  details text,
  created_at timestamptz not null default now()
);
create table if not exists otps (
  phone text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  sent_count int not null default 1,
  window_start timestamptz not null default now()
);
create table if not exists sessions (
  token text primary key,
  role text not null,                 -- customer | store | driver | admin
  subject_id uuid,
  expires_at timestamptz not null
);

-- الكتالوج الموحّد (كل البقالات تسعّر من نفس القائمة)
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  size text,
  unit text not null default 'حبة',
  category text not null default 'أخرى',
  aliases text[] not null default '{}',
  icon text,
  name_en text, name_ur text, name_bn text, name_hi text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- البقالات
create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_phone text unique not null,
  pin_hash text not null,
  lat double precision not null,
  lng double precision not null,
  area text,
  is_open boolean not null default true,
  self_delivery boolean not null default false,
  worker_lang text not null default 'ur',
  commission_pct numeric(5,2),
  rating_sum int not null default 0,
  rating_n int not null default 0,
  respond_ms_sum bigint not null default 0,
  respond_n int not null default 0,
  offers_n int not null default 0,
  accepted_n int not null default 0,
  price_violations int not null default 0,
  suspended boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists store_products (
  store_id uuid not null references stores(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  price numeric(10,2) not null,
  available boolean not null default true,
  confidence real not null default 0.8,     -- يتعلم من «عندي / ما عندي»
  updated_at timestamptz not null default now(),
  primary key (store_id, product_id)
);

-- المناديب
create table if not exists drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text unique not null,
  pin_hash text not null,
  company text,
  online boolean not null default false,
  lat double precision, lng double precision,
  seen_at timestamptz,
  rating_sum int not null default 0,
  rating_n int not null default 0,
  created_at timestamptz not null default now()
);

-- الطلبات
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  number serial,
  customer_id uuid not null references customers(id),
  lat double precision not null, lng double precision not null,
  address_details text,
  status text not null default 'pending_payment',
  -- pending_payment | searching | needs_customer | preparing | ready | delivering | delivered | cancelled
  items jsonb not null,                  -- [{product_id,name_ar,qty,unit,quote_price}]
  quote_subtotal numeric(10,2) not null,
  delivery_fee numeric(10,2) not null,
  discount numeric(10,2) not null default 0,
  quote_total numeric(10,2) not null,
  final_total numeric(10,2),
  paid_amount numeric(10,2) not null default 0,
  refunded_amount numeric(10,2) not null default 0,
  payment_status text not null default 'pending',   -- pending | paid | failed
  payment_ref text,
  promo_code text,
  source text not null default 'app',               -- app | voice | repeat
  transcript text,
  note text,
  delivery_code text not null,
  driver_id uuid references drivers(id),
  driver_pay numeric(10,2),
  dispatch_round int not null default 0,
  customer_prompt jsonb,                 -- سؤال للعميل (منتجات ناقصة)
  rating_store int, rating_driver int, rating_note text,
  created_at timestamptz not null default now(),
  paid_at timestamptz, assigned_at timestamptz, ready_at timestamptz, picked_at timestamptz, delivered_at timestamptz, cancelled_at timestamptz,
  cancel_reason text
);
create index if not exists orders_customer on orders(customer_id, created_at desc);
create index if not exists orders_status on orders(status);

-- كل طلب يتقسم على بقالة أو أكثر (سلة من أكثر من محل)
create table if not exists order_parts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  store_id uuid not null references stores(id),
  items jsonb not null,                  -- [{product_id,name_ar,qty,unit,price,quote_price,status,sub}]
  subtotal numeric(10,2) not null,
  commission numeric(10,2) not null,
  status text not null default 'preparing',   -- preparing | ready | picked | cancelled
  created_at timestamptz not null default now(),
  ready_at timestamptz, picked_at timestamptz
);
create index if not exists parts_store on order_parts(store_id, status);
create index if not exists parts_order on order_parts(order_id);

create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  store_id uuid not null references stores(id),
  round int not null,
  items jsonb not null,                  -- العناصر المعروضة على هالبقالة بأسعارها
  basket_price numeric(10,2) not null,
  status text not null default 'pending',     -- pending | accepted | partial | declined | expired | lost
  expires_at timestamptz not null,
  responded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists offers_store on offers(store_id, status);
create index if not exists offers_order on offers(order_id, round);

create table if not exists driver_offers (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  driver_id uuid not null references drivers(id),
  pay numeric(10,2) not null,
  status text not null default 'pending',     -- pending | accepted | declined | expired | lost
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists substitutions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  part_id uuid not null references order_parts(id) on delete cascade,
  item_index int not null,
  product_id uuid not null references products(id),
  name_ar text not null,
  price numeric(10,2) not null,
  status text not null default 'pending',     -- pending | approved | rejected | expired
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists complaints (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  part_id uuid references order_parts(id),
  item_product_id uuid,
  kind text not null,                    -- damaged | expired | wrong | missing | late | other
  note text,
  photo text,
  refund numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

-- كل حركة فلوس: للتسويات اليومية والأسبوعية
create table if not exists ledger (
  id bigserial primary key,
  kind text not null,                    -- customer_payment | refund | store_earning | commission | driver_pay | store_penalty | delivery_fee | promo
  order_id uuid references orders(id) on delete cascade,
  store_id uuid references stores(id),
  driver_id uuid references drivers(id),
  amount numeric(10,2) not null,
  settled boolean not null default false,
  settlement_id uuid,
  note text,
  created_at timestamptz not null default now()
);
create table if not exists settlements (
  id uuid primary key default gen_random_uuid(),
  party text not null,                   -- store | driver
  party_id uuid not null,
  amount numeric(10,2) not null,
  status text not null default 'due',    -- due | paid
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table if not exists promos (
  code text primary key,
  amount numeric(10,2) not null,
  first_order_only boolean not null default true,
  active boolean not null default true
);
create table if not exists promo_uses (
  code text not null,
  customer_id uuid not null,
  order_id uuid,
  primary key (code, customer_id)
);

create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid unique references customers(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  details text,
  created_at timestamptz not null default now()
);

alter table products add column if not exists image text;

-- صور يرفعها أصحاب البقالات لمنتجاتهم، وتنعرض للعملاء بعد موافقة الإدارة
create table if not exists product_photos (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  store_id uuid references stores(id) on delete set null,
  path text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists push_subs (
  id uuid primary key default gen_random_uuid(),
  role text not null,
  subject_id uuid,
  endpoint text unique not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

alter table drivers add column if not exists suspended boolean not null default false;
alter table orders add column if not exists payment_method text not null default 'online';

-- بقالتي، مشوار الجيران، الدفتر
alter table customers add column if not exists home_store_id uuid references stores(id);
alter table orders add column if not exists prefer_store_id uuid references stores(id);
alter table orders add column if not exists exclusive boolean not null default false;
alter table orders add column if not exists join_of uuid references orders(id);
create table if not exists tabs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  credit_limit numeric(10,2) not null default 0,
  balance numeric(10,2) not null default 0,
  status text not null default 'requested',   -- requested | open | closed
  created_at timestamptz not null default now(),
  unique (customer_id, store_id)
);
create table if not exists tab_entries (
  id bigserial primary key,
  tab_id uuid not null references tabs(id) on delete cascade,
  order_id uuid references orders(id),
  amount numeric(10,2) not null,              -- موجب = على العميل، سالب = سدّد
  note text,
  created_at timestamptz not null default now()
);

-- صور البقالات تنحفظ في قاعدة البيانات نفسها، عشان تشتغل على أي استضافة حتى المجانية
alter table product_photos add column if not exists data bytea;
alter table product_photos add column if not exists mime text;
