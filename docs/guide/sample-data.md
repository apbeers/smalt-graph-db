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
