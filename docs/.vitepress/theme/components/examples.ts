/** Example queries for each playground dataset. Every one runs in test/docs-examples.test.ts. */
export type DatasetKey = 'social' | 'family' | 'metro' | 'ontology' | 'network' | 'big'

export interface Example {
  readonly title: string
  readonly query: string
}

const networkExamples: Example[] = [
  { title: 'Everyone and who they know', query: 'MATCH (p:Person)-[k:KNOWS]->(q:Person)\nRETURN p, k, q\nLIMIT 3000' },
  { title: 'Most connected', query: 'MATCH (p:Person)-[:KNOWS]-(f)\nRETURN p.name AS name, count(f) AS friends\nORDER BY friends DESC\nLIMIT 10' },
  { title: 'Two hops from one person', query: "MATCH path = (p:Person {name: 'Bo 1'})-[:KNOWS*1..2]-(f)\nRETURN path" },
  { title: 'Shortest path', query: "MATCH (a:Person {name: 'Bo 1'}), (b:Person {name: 'Gus 6'})\nMATCH p = shortestPath((a)-[:KNOWS*]-(b))\nRETURN p" },
  { title: 'People per city', query: 'MATCH (p:Person)-[:LIVES_IN]->(c:City)\nRETURN c.name AS city, count(p) AS people, round(avg(p.age)) AS age\nORDER BY people DESC' },
  { title: 'A community', query: 'MATCH (a:Person {community: 2})-[k:KNOWS]-(b:Person {community: 2})\nRETURN a, k, b\nLIMIT 2000' },
]

export const EXAMPLES: Record<DatasetKey, Example[]> = {
  social: [
    { title: 'Who knows whom', query: 'MATCH (a:Person)-[k:KNOWS]->(b:Person)\nRETURN a, k, b' },
    { title: 'Friends of friends', query: "MATCH (a:Person {name: 'Ada'})-[:KNOWS*1..2]->(f)\nRETURN DISTINCT f.name AS name" },
    { title: 'Shortest path', query: "MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Radia'})\nMATCH p = shortestPath((a)-[*]-(b))\nRETURN p" },
    { title: 'Same city, same topic', query: 'MATCH (a:Person)-[:LIVES_IN]->(c)<-[:LIVES_IN]-(b:Person),\n      (a)-[:LIKES]->(t)<-[:LIKES]-(b)\nWHERE a.name < b.name\nRETURN a.name, b.name, c.name AS city, t.name AS topic' },
    { title: 'Topics by city', query: 'MATCH (c:City)<-[:LIVES_IN]-(p:Person)-[:LIKES]->(t:Topic)\nRETURN c.name AS city, collect(DISTINCT t.name) AS topics\nORDER BY city' },
    { title: 'Nobody knows them', query: 'MATCH (p:Person)\nWHERE NOT ()-[:KNOWS]->(p)\nRETURN p.name' },
    { title: 'Add someone', query: "MATCH (ada:Person {name: 'Ada'})\nCREATE (you:Person {name: 'You', born: 2000})-[:KNOWS {since: 2026}]->(ada)\nRETURN you, ada" },
    { title: 'EXPLAIN a query', query: "EXPLAIN MATCH (a:Person {name: 'Ada'})-[:KNOWS*1..3]->(f)\nWHERE f.born > 1900\nRETURN f.name" },
  ],
  family: [
    { title: 'The whole family', query: 'MATCH (a)-[r]->(b)\nRETURN a, r, b' },
    { title: 'Built on smaltdb', query: "MATCH (p:Product)-[:BUILT_ON]->(:Product {name: 'smaltdb'})\nRETURN p.name AS product, p.line AS line" },
    { title: 'What an analyst touches', query: "MATCH path = (:Role {name: 'Analyst'})-[*1..3]->(x)\nRETURN path" },
    { title: 'Languages', query: 'MATCH (l:Language)\nRETURN l.name AS name, l.line AS line\nORDER BY name' },
  ],
  metro: [
    { title: 'The network', query: 'MATCH (a:Station)-[c:CONNECTS]->(b:Station)\nWHERE id(a) < id(b)\nRETURN a, c, b' },
    { title: 'Fewest stops', query: "MATCH (:Line {name: 'Line 1'})<-[:ON]-(s)\nWITH collect(s) AS stops\nWITH stops[0] AS a, stops[-1] AS b\nMATCH p = shortestPath((a)-[:CONNECTS*]->(b))\nRETURN p" },
    { title: 'Transfer stations', query: 'MATCH (s:Station)-[:ON]->(l:Line)\nWITH s, count(l) AS lines\nWHERE lines > 1\nRETURN s.name AS station, lines\nORDER BY lines DESC' },
    { title: 'Line lengths', query: 'MATCH (l:Line)<-[:ON]-(s)\nRETURN l.name AS line, count(s) AS stations\nORDER BY line' },
  ],
  ontology: [
    { title: 'The platform now', query: 'MATCH (a)-[r]->(b)\nRETURN a, r, b' },
    { title: 'Who changed what', query: 'UNWIND commits() AS c\nRETURN c.version AS version, substring(c.at, 0, 10) AS day, c.author AS author, c.message AS message' },
    { title: 'Two weeks in', query: 'AT VERSION 8\nMATCH (a)-[r]->(b)\nRETURN a, r, b' },
    { title: 'ingest_orders in July', query: "AT TIME '2026-07-06T12:00:00Z'\nMATCH (f:Flow {name: 'ingest_orders'})-[r]-(x)\nRETURN f, r, x" },
    { title: 'History of orders', query: "MATCH (d:Dataset {name: 'orders'})\nUNWIND history(d) AS h\nRETURN h.version AS version, h.author AS author, h.change AS change, h.key AS key, h.new AS value" },
    { title: 'What feeds churn', query: "MATCH p = (:Dashboard {name: 'Churn risk'})-[:SHOWS]->()-[:READS|WRITES*1..8]-(:Dataset)\nRETURN p" },
    { title: 'Add a flow', query: "MATCH (s:Dataset {name: 'sessions'}), (t:Team {name: 'Growth'})\nCREATE (f:Flow {name: 'session_alerts', schedule: 'hourly', status: 'active'})-[:READS]->(s), (t)-[:OWNS]->(f)\nRETURN f, s, t" },
  ],
  network: networkExamples,
  big: networkExamples,
}
