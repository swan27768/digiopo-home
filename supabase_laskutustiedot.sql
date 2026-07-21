-- ═══════════════════════════════════════════════════════════════════════════
--  Ostajan laskutustiedot lisenssit-tauluun
--  Aja tämä ENNEN kuin api/tilaus.js ja tilauslomake.html viedään tuotantoon.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  MIKSI
--
--  Kunta on hankintayksikkö, ja verkkolaskulaki (241/2019) antaa sille
--  oikeuden vaatia lasku verkkolaskuna. Verkkolaskua ei voi muodostaa ilman
--  ostajan Y-tunnusta, verkkolaskuosoitetta ja välittäjätunnusta – eikä se
--  mene maksuun ilman ostajan omaa viitettä ("Viitteenne"), koska ilman sitä
--  lasku ei löydä asiatarkastajaa kunnan järjestelmässä.
--
--  Nämä kysytään nyt tilauslomakkeella ja tallennetaan tilauksen yhteydessä,
--  eikä selvitetä jälkikäteen sähköpostiketjussa jokaisen kaupan kohdalla.
--
--  ⚠️  JAETTU TAULU. `lisenssit` on käytössä myös digiopo-repossa
--     (app.digiopo.fi). Sarakkeiden lisääminen on turvallista – olemassa oleva
--     koodi ei niitä lue eikä kirjoita – mutta skeeman kuvaus asuu siellä:
--         digiopo/supabase_schema.sql
--         digiopo/docs/03-tietokanta.md
--     Päivitä kuvaus, kun tämä on ajettu.
--
-- ───────────────────────────────────────────────────────────────────────────


-- ─── 1. Sarakkeet ──────────────────────────────────────────────────────────
--
-- Kaikki sallivat NULLin, koska:
--   · opettajalisenssin ostaa yksityishenkilö, jolla ei ole näitä tietoja
--   · vanhat rivit on luotu ennen tätä muutosta
--   · käsin SQL:llä luodut testilisenssit eivät niitä tarvitse
--
-- Pakollisuus ratkaistaan sovelluksessa (api/tilaus.js), jossa tiedetään
-- onko kyseessä koulu- vai opettajalisenssi. Kannassa NOT NULL kaataisi
-- opettajalisenssit ja kaikki käsin luodut rivit.

alter table lisenssit add column if not exists laskutus_nimi              text;
alter table lisenssit add column if not exists laskutus_ytunnus           text;
alter table lisenssit add column if not exists laskutus_verkkolaskuosoite text;
alter table lisenssit add column if not exists laskutus_valittajatunnus   text;
alter table lisenssit add column if not exists laskutus_viitteenne        text;

comment on column lisenssit.laskutus_nimi              is 'Laskutettava organisaatio (kunta/kuntayhtymä), ei koulu';
comment on column lisenssit.laskutus_ytunnus           is 'Ostajan Y-tunnus, normalisoitu muotoon 1234567-8';
comment on column lisenssit.laskutus_verkkolaskuosoite is 'OVT-tunnus, ilman välilyöntejä';
comment on column lisenssit.laskutus_valittajatunnus   is 'Ostajan verkkolaskuoperaattorin välittäjätunnus';
comment on column lisenssit.laskutus_viitteenne        is 'Ostajan oma viite/tilausnumero – ilman tätä lasku ei mene maksuun';


-- ─── 2. Muotorajoite Y-tunnukselle ─────────────────────────────────────────
--
-- Sovellus normalisoi Y-tunnuksen muotoon 1234567-8 ennen tallennusta, mutta
-- kannassa on myös käsin luotuja rivejä. Rajoite pitää sarakkeen yhtenäisenä,
-- jotta verkkolaskun muodostus voi luottaa muotoon.
--
-- NOT VALID: rajoitetta ei tarkisteta vanhoihin riveihin (ne ovat NULL, mutta
-- jos joukossa olisi poikkeama, ALTER kaatuisi kesken ajon). Uudet ja
-- päivittyvät rivit tarkistetaan normaalisti.

alter table lisenssit drop constraint if exists lisenssit_laskutus_ytunnus_muoto;
alter table lisenssit add  constraint lisenssit_laskutus_ytunnus_muoto
  check (laskutus_ytunnus is null or laskutus_ytunnus ~ '^\d{7}-\d$')
  not valid;


-- ─── 3. Työjono: koululisenssit joilta laskutustiedot puuttuvat ────────────
--
-- Kaikki ennen tätä muutosta luodut koululisenssit ovat tällaisia. Niitä ei
-- voi laskuttaa verkkolaskuna ennen kuin tiedot on täydennetty käsin.

create or replace view laskutustiedot_puuttuu as
  select koodi, koulu, yhteyshenkilö, email, laskunumero, lasku_pvm
    from lisenssit
   where tyyppi in ('vuosi', 'kunta')
     and aktiivinen
     and (laskutus_ytunnus is null or laskutus_viitteenne is null)
   order by lasku_pvm nulls last;

comment on view laskutustiedot_puuttuu is
  'Koululisenssit joilta puuttuu verkkolaskutukseen vaadittava tieto. Pitäisi olla tyhjä.';


-- ─── 4. Tarkistus ──────────────────────────────────────────────────────────

-- Sarakkeet ovat paikallaan:
--   select column_name, data_type
--     from information_schema.columns
--    where table_name = 'lisenssit' and column_name like 'laskutus%'
--    order by column_name;

-- Työjono (tyhjä, jos koululisenssejä ei vielä ole):
--   select * from laskutustiedot_puuttuu;

-- Rajoite hylkää virheellisen muodon:
--   update lisenssit set laskutus_ytunnus = '12345678' where false;  -- ei tee mitään
--   -- oikea testi vasta ensimmäisellä testitilauksella
