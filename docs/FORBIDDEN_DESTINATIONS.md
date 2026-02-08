# Forbidden Destination Filtering

## Overview

The route search algorithm now automatically excludes routes that pass through forbidden destinations. This ensures compliance with legal restrictions and trade regulations.

## How It Works

### 1. Restriction Database
Forbidden routes are stored in the `logistics_restrictions` table in the meta database:

```sql
CREATE TABLE logistics_restrictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    reason TEXT NOT NULL
);
```

Example restriction:
```
origin: ICN (Incheon, South Korea)
destination: FNJ (Pyongyang, North Korea)
reason: 법령상 금지된 노선입니다. (Legally prohibited route)
```

### 2. Country-Level Filtering
When searching for routes from an origin airport:
1. The system extracts all unique destination countries from blocked rules
2. During route exploration, any airport in a forbidden country is **automatically excluded** from the path
3. This prevents indirect routes like: ICN → PEK (China) → FNJ (North Korea)

### 3. Implementation Details

#### Core Algorithm Changes
- **Header file** (`include/nuke_flight.h`): Added `forbidden_countries` and `forbidden_count` to `nuke_search_params_t`
- **Route search** (`src/nuke_flight.c`): Added `is_country_forbidden()` check in the path exploration loop
- **Server handler** (`src/server.c`): Automatically collects forbidden countries based on block rules before search

#### Example
Given these restrictions:
```
ICN -> FNJ (North Korea forbidden)
```

The system will:
1. ✅ Allow direct routes: ICN → PEK (China)
2. ✅ Allow multi-hop routes: ICN → NRT (Japan) → LAX (USA)
3. ❌ Block direct routes: ICN → FNJ (North Korea)
4. ❌ Block indirect routes: ICN → PEK → FNJ (China → North Korea)
5. ❌ Block any path: ICN → ... → [any North Korean airport]

## Testing

Run the forbidden destinations test:
```bash
make test_forbidden  # (if available)
```

The test verifies:
- Direct blocked routes return HTTP 403 Forbidden
- Routes to allowed countries succeed
- Multi-hop paths never include airports from forbidden countries

## Database Management

### Adding a Restriction
```sql
INSERT INTO logistics_restrictions (origin, destination, reason)
VALUES ('ICN', 'FNJ', '법령상 금지된 노선입니다.');
```

### Viewing All Restrictions
```sql
SELECT * FROM logistics_restrictions;
```

### Removing a Restriction
```sql
DELETE FROM logistics_restrictions WHERE origin='ICN' AND destination='FNJ';
```

## Performance Impact

The forbidden destination check adds minimal overhead:
- **O(k)** check per explored airport, where k = number of forbidden countries
- Typically k is very small (< 10)
- Check happens after bounds checking but before cycle detection
- No performance impact on routes with zero restrictions
