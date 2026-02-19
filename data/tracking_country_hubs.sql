-- Canonical list of well-known logistics hub airports per country.
-- This file is the single source of truth for heuristics that resolve
-- EMS tracking events that only expose a country code without a city.

DROP TABLE IF EXISTS tracking_country_hubs;
CREATE TABLE tracking_country_hubs (
  iso_code TEXT PRIMARY KEY,
  airport_code TEXT NOT NULL,
  airport_name TEXT NOT NULL,
  throughput_rank INTEGER NOT NULL DEFAULT 1
);

INSERT INTO tracking_country_hubs (iso_code, airport_code, airport_name, throughput_rank) VALUES
  ('KR', 'ICN', 'Incheon International Airport', 1),
  ('US', 'JFK', 'New York John F. Kennedy International Airport', 1),
  ('CN', 'PVG', 'Shanghai Pudong International Airport', 1),
  ('JP', 'NRT', 'Tokyo Narita International Airport', 1),
  ('DE', 'FRA', 'Frankfurt am Main Airport', 1),
  ('GB', 'LHR', 'London Heathrow Airport', 1),
  ('FR', 'CDG', 'Paris Charles de Gaulle Airport', 1),
  ('AE', 'DXB', 'Dubai International Airport', 1),
  ('HK', 'HKG', 'Hong Kong International Airport', 1),
  ('SG', 'SIN', 'Singapore Changi Airport', 1),
  ('NL', 'AMS', 'Amsterdam Schiphol Airport', 1),
  ('AU', 'SYD', 'Sydney Kingsford Smith Airport', 1),
  ('CA', 'YYZ', 'Toronto Pearson International Airport', 1),
  ('BR', 'GRU', 'Sao Paulo-Guarulhos International Airport', 1),
  ('CL', 'SCL', 'Santiago Arturo Merino Benitez Airport', 1),
  ('MX', 'MEX', 'Mexico City International Airport', 1),
  ('TH', 'BKK', 'Bangkok Suvarnabhumi Airport', 1),
  ('VN', 'SGN', 'Ho Chi Minh Tan Son Nhat International Airport', 1),
  ('MY', 'KUL', 'Kuala Lumpur International Airport', 1),
  ('PH', 'MNL', 'Manila Ninoy Aquino International Airport', 1),
  ('IN', 'DEL', 'Delhi Indira Gandhi International Airport', 1),
  ('TR', 'IST', 'Istanbul Airport', 1),
  ('SA', 'RUH', 'Riyadh King Khalid International Airport', 1),
  ('QA', 'DOH', 'Doha Hamad International Airport', 1),
  ('ZA', 'JNB', 'Johannesburg OR Tambo International Airport', 1),
  ('IT', 'FCO', 'Rome Fiumicino International Airport', 1),
  ('ES', 'MAD', 'Madrid Barajas International Airport', 1),
  ('SE', 'ARN', 'Stockholm Arlanda Airport', 1),
  ('FI', 'HEL', 'Helsinki Airport', 1),
  ('RU', 'SVO', 'Moscow Sheremetyevo International Airport', 1);
