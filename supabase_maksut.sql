-- ═══════════════════════════════════════════════════════════════════════════
--  Verkkomaksut (Paytrail) – odottavien maksujen taulu
--  Aja tämä Supabasen SQL-editorissa ENNEN kuin api/tilaus.js:n verkkomaksu-
--  versio ja api/maksu-*.js otetaan käyttöön.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  MIKSI
--
--  Verkkomaksussa lisenssiä EI saa luoda ennen kuin maksu on oikeasti maksettu.
--  Vanha laskumalli loi lisenssin heti ja luotti siihen, että lasku maksetaan
--  myöhemmin. Paytrailissa järjestys kääntyy: ostaja ohjataan ensin maksamaan,
--  ja lisenssi luodaan vasta kun Paytrail vahvistaa maksun onnistuneeksi.
--
--  Tilaus on siis "odotustilassa" siitä hetkestä kun ostaja lähettää lomakkeen
--  siihen kun hän palaa maksettuaan. Tilauksen tiedot on säilytettävä jossain
--  sen ajan – niitä ei voi pitää selaimessa, koska maksun vahvistus tulee
--  Paytrailin palvelimelta suoraan meidän palvelimelle (callback), ei selaimen
--  kautta. Tämä taulu on se säilö.
--
--  IDEMPOTENSSI: Paytrail ilmoittaa onnistuneesta maksusta KAHDESTI – kerran
--  selaimen paluu-URLiin (redirect) ja kerran palvelinkutsuna (callback). Näistä
--  kumpi tahansa voi tulla ensin, ja molemmat voivat tulla lähes samanaikaisesti.
--  `tila`-sarake ja atominen tilasiirtymä (odottaa → kasittelyssa → maksettu)
--  varmistavat, että lisenssi luodaan ja sähköpostit lähetetään täsmälleen kerran.
--
--  ⚠️  TÄMÄ ON DIGIOPO-HOMEN OMA TAULU. Toisin kuin `lisenssit`, tätä taulua ei
--     jaeta app.digiopo.fi:n kanssa – se on vain tämän projektin tilausputken
--     välivarasto. Valmis lisenssi kirjoitetaan silti jaettuun `lisenssit`-tauluun.
--
-- ───────────────────────────────────────────────────────────────────────────


-- ─── 1. Taulu ──────────────────────────────────────────────────────────────
--
-- stamp        Meidän generoima uniikki maksutunniste. Lähetetään Paytrailiin ja
--              palaa takaisin maksun vahvistuksessa – näin löydämme oikean rivin.
-- reference    Paytrailin "reference" (viite). Näkyy myös meidän tositteella.
-- tila         odottaa | kasittelyssa | maksettu | peruttu | virhe
-- tilaus       Koko tilauslomakkeen sisältö JSONina (etunimi, koulu, kunta,
--              oppilasmaara, lisenssikausi, hinta jne.). Tästä lisenssi luodaan.
-- laskunumero  Varataan vasta maksun onnistuttua – maksamaton tilaus ei polta
--              laskunumeroa (juokseva numerointi ei saa reikiä keskeneräisistä).
-- koodi        Luotu koulukoodi. Talletetaan, jotta redirect ja callback eivät
--              luo kahta lisenssiä ja jotta koodi voidaan näyttää paluusivulla.

create table if not exists maksut (
  id             uuid        primary key default gen_random_uuid(),
  stamp          text        unique not null,
  reference      text        not null,
  tila           text        not null default 'odottaa',
  summa_sentteina integer    not null,
  tilaus         jsonb       not null,
  transaction_id text,
  laskunumero    text,
  koodi          text,
  luotu_at       timestamptz not null default now(),
  maksettu_at    timestamptz
);

-- Nopea haku stampilla (maksun vahvistus etsii rivin sillä).
create index if not exists maksut_stamp_idx on maksut (stamp);


-- ─── 2. Row Level Security ─────────────────────────────────────────────────
--
-- Sama periaate kuin muissa tauluissa (lisenssit, laskunumerot): selain ei
-- koskaan lue tätä suoraan. Kaikki kulkee palvelinfunktioiden kautta
-- service_role-avaimella, joka ohittaa RLS:n. `using (false)` sulkee taulun
-- kaikilta muilta rooleilta – myös julkiselta anon-avaimelta.

alter table maksut enable row level security;

drop policy if exists maksut_ei_paasya on maksut;
create policy maksut_ei_paasya on maksut for all using (false);

revoke all on table maksut from anon;
revoke all on table maksut from authenticated;


-- ─── 3. Tarkistus ──────────────────────────────────────────────────────────
--
-- Odottavat ja epäonnistuneet maksut näet näin (siivousta / seurantaa varten):
--   select stamp, tila, summa_sentteina, luotu_at, tilaus->>'koulu' as koulu
--     from maksut
--    order by luotu_at desc
--    limit 50;
--
-- Vanhat 'odottaa'-rivit (ostaja ei koskaan maksanut) voi poistaa turvallisesti:
--   delete from maksut where tila = 'odottaa' and luotu_at < now() - interval '7 days';
