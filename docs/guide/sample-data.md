---
dataset: social
---

# Sample data

Every example in these docs runs where it stands: press **Run**, and the result shows as a table and, when it holds
nodes, relationships or paths, as a graph drawn on the GPU. **Edit** changes the query; each run starts from the
dataset as generated, so nothing a run writes stays. The same datasets are in
`@smaltworks/smaltcy/datasets`, and in the [playground](/playground).

## Social

Twelve people, the cities they live in, the topics they like, and who knows whom. Most examples in these docs use
it.

```cypher
MATCH (p:Person)-[r]->(x)
RETURN p, r, x
```

Who is two steps from Ada, and how:

```cypher
MATCH path = (:Person {name: 'Ada'})-[:KNOWS*1..2]-(p:Person)
RETURN path
```

## The smalt family

The smalt products, what each is built on, and who uses them.

```cypher dataset=family
MATCH (a)-[r]->(b)
RETURN a, r, b
```

Everything an analyst reaches in up to three steps:

```cypher dataset=family
MATCH path = (:Role {name: 'Analyst'})-[*1..3]->(x)
RETURN path
```

## Metro

A made-up metro: 8 lines of 30 stops across a city, with transfers where lines meet. Each `CONNECTS` relationship
has its line and the minutes it takes.

```cypher dataset=metro
MATCH (a:Station)-[c:CONNECTS]->(b:Station)
WHERE id(a) < id(b)
RETURN a, c, b
```

The route with the fewest stops from one end of Line 1 to the other:

```cypher dataset=metro
MATCH (:Line {name: 'Line 1'})<-[:ON]-(s)
WITH collect(s) AS stops
WITH stops[0] AS a, stops[-1] AS b
MATCH p = shortestPath((a)-[:CONNECTS*]->(b))
RETURN p
```

Stations where you can change lines:

```cypher dataset=metro
MATCH (s:Station)-[:ON]->(l:Line)
WITH s, collect(l.name) AS lines
WHERE size(lines) > 1
RETURN s.name AS station, lines
ORDER BY size(lines) DESC, station
```

## Network

People who know each other, grown by preferential attachment: the well-connected make more friends, mostly in their
own community. The examples here run on 2,000 people; the [tech demo](/demo) draws up to 100,000.

```cypher dataset=network
MATCH path = (:Person {name: 'Bo 1'})-[:KNOWS*1..2]-(f)
RETURN path
LIMIT 300
```

The best-connected people and their communities:

```cypher dataset=network
MATCH (p:Person)-[:KNOWS]-(f)
RETURN p.name AS name, p.community AS community, count(f) AS friends
ORDER BY friends DESC
LIMIT 10
```

How far apart two people are:

```cypher dataset=network
MATCH (a:Person {name: 'Bo 1'}), (b:Person {name: 'Gus 6'})
MATCH p = shortestPath((a)-[:KNOWS*]-(b))
RETURN p
```

## Real-world shapes

Seven more generated graphs, each with the shape of a real system, so a query or a drawing looks like a problem you
know. Each takes a size and a seed, is the same every time for them, and can come with its growth as history: a
commit per hire, publish, flight route or deploy. The examples here run on 300 nodes; the [tech demo](/demo) draws
each from 50 to 100,000.

```ts
import { open } from '@smaltworks/smaltcy';
import { orgChart, packages } from '@smaltworks/smaltcy/datasets';

const company = open();
company.load(orgChart(1000));

// With its growth: a commit per package published.
const registry = open({ history: true });
registry.load(packages(5000, { seed: 3, history: true }));
```

| Function | A graph like | Shape | Labels and relationships |
| --- | --- | --- | --- |
| `orgChart` | A company's reporting lines | A deep tree: about one relationship per person | `:Employee`, `REPORTS_TO`, `MENTORS` |
| `packages` | npm: packages and what they depend on | A few hubs under thousands, most with no dependents | `:Package`, `DEPENDS_ON` |
| `airline` | Airline routes | Hub and spoke: stars joined at their centres | `:Airport:Hub`, `ROUTE {airline, km}` |
| `powerGrid` | A power grid on a map | Spread out: a few links each, long paths | `:Substation`, `:Plant`, `LINE {kV, km}`, `FEEDS` |
| `gitHistory` | A repository's commits | Long chains that fork and merge | `:Commit:Merge`, `PARENT` |
| `supplyChain` | Suppliers to stores | Five tiers, four hops deep | `:Supplier` … `:Store`, `SUPPLIES {product, leadDays}` |
| `microservices` | Services, their calls and databases | Tight team clusters, few bridges | `:Service:Gateway`, `:Database`, `CALLS`, `USES` |

### Org chart

The chain of command from the newest hire up to the CEO:

```cypher dataset=org-chart
MATCH (e:Employee)
WITH e ORDER BY id(e) DESC LIMIT 1
MATCH p = (e)-[:REPORTS_TO*]->(:Employee {level: 0})
RETURN p
```

### Package dependencies

The most depended-on packages:

```cypher dataset=packages
MATCH (p:Package)<-[:DEPENDS_ON]-(d)
RETURN p.name AS package, count(d) AS dependents
ORDER BY dependents DESC
LIMIT 5
```

### Airline routes

The fewest flights between the first airport and the newest:

```cypher dataset=airline
MATCH (b:Airport)
WITH b ORDER BY id(b) DESC LIMIT 1
MATCH (a:Airport {code: 'AAA'})
MATCH p = shortestPath((a)-[:ROUTE*]-(b))
RETURN p
```

### Power grid

Every substation within three lines of the first one built:

```cypher dataset=power-grid
MATCH (a:Substation)
WITH a ORDER BY id(a) LIMIT 1
MATCH p = (a)-[:LINE*1..3]-(n)
RETURN p
LIMIT 200
```

### Git history

The merges, and the branch each brought in:

```cypher dataset=git-history
MATCH (m:Merge)-[:PARENT]->(c:Commit)
WHERE c.branch <> 'main'
RETURN m.hash AS merge, c.branch AS branch, m.author AS author
```

### Supply chain

Where one store's goods come from, four hops back:

```cypher dataset=supply-chain
MATCH (s:Store)
WITH s LIMIT 1
MATCH p = (:Supplier)-[:SUPPLIES*4]->(s)
RETURN p
```

### Microservices

The calls that cross from one team to another:

```cypher dataset=microservices
MATCH (a:Service)-[c:CALLS]->(b:Service)
WHERE a.team <> b.team
RETURN a, c, b
```
