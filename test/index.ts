import fetch from 'node-fetch'
import {compile} from '../src/index'
import {writeFileSync} from 'fs'

async function getSchema() {
  const url = 'https://site-api.datocms.com/docs/site-api-hyperschema.json'
  const res = await fetch(url)
  return res.json()
}

;(async () => {
  try {
    const schema = await getSchema()
    const typings = await compile(schema, 'SiteApiSchema', {})
    writeFileSync('./test/SiteApiSchema.d.ts', typings, 'utf8')
  } catch (e) {
    console.error(e)
  }
})()
