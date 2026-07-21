-- ═══════════════════════════════════════════════════════════════════════════
--  Juokseva laskunumerointi
--  Aja tämä Supabasen SQL-editorissa ennen kuin api/tilaus.js otetaan käyttöön.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  MIKSI
--
--  Laskunumero arvottiin aiemmin väliltä 1000–9999 ja liitettiin vuosiluvun
--  perään (esim. "20261847"). Neljä satunnaista numeroa törmää nopeasti:
--
--      50 laskua  → 12 %  todennäköisyys, että kaksi saa saman numeron
--     100 laskua  → 39 %
--     200 laskua  → 86 %
--
--  Kaksi laskua samalla numerolla rikkoo kirjanpidon tositeketjun, ja
--  verkkolaskuoperaattori hylkää jälkimmäisen. Törmäystä ei myöskään huomaisi
--  kukaan, koska mikään ei tarkistanut numeron ainutlaatuisuutta.
--
--  Nyt numero varataan kannasta atomisesti. Muoto säilyy samana (VVVV + 4
--  numeroa), joten laskun ulkoasu, viitenumeron laskenta ja lisenssit-taulun
--  laskunumero-sarake toimivat ennallaan – vain arvonta vaihtuu juoksevaksi.
--
-- ───────────────────────────────────────────────────────────────────────────


-- ─── 1. Laskuri ────────────────────────────────────────────────────────────
--
-- Yksi rivi per vuosi. `seuraava` on aina se numero, joka annetaan seuraavaksi.
-- Numerointi alkaa joka vuosi ykkösestä, koska vuosiluku on osa laskunumeroa.

create table if not exists laskunumerot (
  vuosi     int  primary key,
  seuraava  int  not null default 1,
  paivitetty timestamptz not null default now()
);

alter table laskunumerot enable row level security;

-- Sama periaate kuin muissakin tauluissa: selain ei koskaan lue tätä.
-- Kaikki kulkee palvelinfunktion kautta service_role-avaimella, joka ohittaa
-- RLS:n. Ilman policya taulu olisi PostgRESTin kautta täysin suljettu myös
-- anon-avaimelle, mikä on tarkoitus.
drop policy if exists laskunumerot_ei_paasya on laskunumerot;
create policy laskunumerot_ei_paasya on laskunumerot for all using (false);


-- ─── 2. Varausfunktio ──────────────────────────────────────────────────────
--
-- Palauttaa seuraavan vapaan laskunumeron muodossa VVVVNNNN (esim. 20260001)
-- ja kasvattaa laskuria samalla.
--
-- Rinnakkaisuus: UPDATE ottaa rivilukon, joten kaksi yhtäaikaista kutsua
-- serialisoituu eikä voi saada samaa numeroa. Vuoden ensimmäinen kutsu joutuu
-- luomaan rivin – jos kaksi pyyntöä osuu siihen samanaikaisesti, toinen saa
-- unique_violationin ja kiertää silmukan uudelleen UPDATE-haaraan.

create or replace function seuraava_laskunumero()
returns text
language plpgsql
as $$
declare
  v int := extract(year from current_date)::int;
  n int;
begin
  loop
    update laskunumerot
       set seuraava = seuraava + 1,
           paivitetty = now()
     where vuosi = v
    returning seuraava - 1 into n;

    exit when found;

    -- Vuoden ensimmäinen lasku: rivi puuttuu vielä.
    begin
      insert into laskunumerot (vuosi, seuraava) values (v, 2);
      n := 1;
      exit;
    exception when unique_violation then
      -- Toinen pyyntö ehti luoda rivin. Kierretään uudelleen, jolloin
      -- UPDATE-haara hoitaa varauksen.
      null;
    end;
  end loop;

  -- Muoto on kiinteä 4 numeroa, koska api/tilaus.js pilkkoo laskunumeron
  -- näyttöä varten kohdasta 4 (slice(0,4) + "-" + slice(4)). Jos numeroita
  -- tulisi viisi, näyttömuoto ja viitenumero menisivät hiljaisesti rikki.
  -- Mieluummin kaatuu äänekkäästi.
  if n > 9999 then
    raise exception
      'Laskunumerot loppuivat vuodelta % (max 9999). Laajenna muotoa ennen jatkoa.', v;
  end if;

  return v::text || lpad(n::text, 4, '0');
end;
$$;


-- ─── 2b. Käyttöoikeudet ────────────────────────────────────────────────────
--
-- TÄRKEÄ. Postgres antaa uudelle funktiolle EXECUTE-oikeuden PUBLIC-roolille
-- automaattisesti, ja PostgREST julkaisee public-skeeman funktiot RPC-päätteenä.
-- Ilman tätä lohkoa kuka tahansa voisi kutsua
--
--     POST /rest/v1/rpc/seuraava_laskunumero
--
-- pelkällä julkisella anon-avaimella ja polttaa laskunumeroita mielin määrin.
-- Se ei paljasta mitään, mutta repii numerointiin aukkoja joita ei pysty
-- selittämään kirjanpidossa – eli tuhoaa juuri sen ominaisuuden jonka takia
-- tämä migraatio tehdään.
--
-- Sama periaate kuin muualla: vain palvelinfunktio service_role-avaimella.

revoke execute on function seuraava_laskunumero() from public;
revoke execute on function seuraava_laskunumero() from anon;
revoke execute on function seuraava_laskunumero() from authenticated;
grant  execute on function seuraava_laskunumero() to   service_role;

revoke all on table laskunumerot from anon;
revoke all on table laskunumerot from authenticated;

-- Tarkistus – tämän pitää palauttaa vain service_role:
--   select grantee, privilege_type
--     from information_schema.routine_privileges
--    where routine_name = 'seuraava_laskunumero';


-- ─── 3. Duplikaattisuoja lisenssit-tauluun ─────────────────────────────────
--
-- Varausfunktio riittää normaalitilanteessa, mutta uniikki indeksi on halpa
-- verkko sen alle: jos laskunumero jostain syystä päätyisi kahdesti, INSERT
-- kaatuu sen sijaan että kanta hiljaa hyväksyisi duplikaatin.
--
-- AJA ENSIN TÄMÄ. Jos vanhassa datassa on jo duplikaatteja (satunnainen
-- numerointi oli käytössä), indeksin luonti epäonnistuu:

--   select laskunumero, count(*)
--     from lisenssit
--    where laskunumero is not null
--    group by laskunumero
--   having count(*) > 1;

-- Jos kysely palauttaa rivejä, korjaa ne käsin ennen indeksin luontia.
-- Partial index: vanhat rivit ilman laskunumeroa (null) eivät häiritse.

create unique index if not exists lisenssit_laskunumero_uniikki
  on lisenssit (laskunumero)
  where laskunumero is not null;


-- ─── 4. Laskurin alustus, jos vanhoja laskuja on jo olemassa ───────────────
--
-- Uusi numerointi alkaa ykkösestä. Jos vuodelle on jo lähetetty satunnaisilla
-- numeroilla laskuja, ne eivät ole juoksevassa järjestyksessä eikä uusi
-- numerointi voi törmätä niihin muuten kuin sattumalta – mutta uniikki indeksi
-- ottaisi törmäyksen kiinni keskellä tilausta, mikä on ikävä paikka.
--
-- Turvallisinta on aloittaa selvästi vanhojen yläpuolelta. Aja tämä kerran,
-- jos kuluvalta vuodelta on jo laskuja:

--   insert into laskunumerot (vuosi, seuraava)
--   values (extract(year from current_date)::int, 1000)
--   on conflict (vuosi) do nothing;
--
-- Tällöin ensimmäinen uusi lasku on VVVV1000. Kirjanpidossa aukko numeroiden
-- alussa on ongelmaton – olennaista on, ettei numero toistu.


-- ─── 5. Tarkistus ──────────────────────────────────────────────────────────

-- Varaa kolme numeroa ja katso että ne juoksevat:
--   select seuraava_laskunumero();
--   select seuraava_laskunumero();
--   select seuraava_laskunumero();
--   select * from laskunumerot;
--
-- Muista nollata laskuri testin jälkeen, jos et halua aukkoa:
--   update laskunumerot set seuraava = 1 where vuosi = extract(year from current_date)::int;
