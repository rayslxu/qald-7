// -*- mode: typescript; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2022 The Board of Trustees of the Leland Stanford Junior University
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Author: Silei Xu <silei@cs.stanford.edu>

import * as argparse from 'argparse';
import * as fs from 'fs';
import * as ThingTalk from 'thingtalk';
import * as Tp from 'thingpedia';
import { genBaseCanonical } from 'genie-toolkit';
import WikidataUtils from './utils/wikidata';
import { sampleAltLabels, waitFinish } from './utils/misc';

async function addArgumentWikidataAltLabels(wikidata : WikidataUtils, arg : ThingTalk.Ast.ArgumentDef, maxCount = 5) {
    const pid : string = arg.getImplementationAnnotation('wikidata_id')!;
    if (!pid) 
        return;
    if (arg.name === 'id' || arg.name === 'instance_of')
        return;
    if (!arg.nl_annotations.canonical) // fake property, skip
        return;
    const altLabels = await wikidata.getAltLabels(pid);
    const labels = sampleAltLabels(altLabels, maxCount);
    const baseCanonical : Record<string, any> = {};
    for (const label of labels) 
        genBaseCanonical(baseCanonical, label, arg.type, null);

    // copy annotation to projections
    for (const key in baseCanonical) {
        if (key === 'default')
            continue;
        if (key.endsWith('_true') || key.endsWith('_false'))
            continue;
        if (key.endsWith('_projection'))
            continue;
        if (key === 'base' && !('property' in baseCanonical)) {
            baseCanonical['property'] = baseCanonical[key]; 
            baseCanonical['property_projection'] = baseCanonical[key];
        }
        if (!((key + '_projection') in baseCanonical)) {
            baseCanonical[key + '_projection'] = [];
            for (const value of baseCanonical[key]) {
                if (!value.includes('#'))
                    baseCanonical[key + '_projection'].push(value);
            }
        }
    }
    Object.assign(arg.nl_annotations.canonical, baseCanonical);
}

async function addQueryWikidataAltLabels(wikidata : WikidataUtils, query : ThingTalk.Ast.FunctionDef, maxCount = 5) {
    const qids : string[] = query.getImplementationAnnotation('wikidata_subject')!;
    const altLabels = [];
    console.log(qids);
    for (const qid of qids) 
        altLabels.push(...(await wikidata.getAltLabels(qid)));
    const labels = sampleAltLabels(altLabels, maxCount);
    query.nl_annotations.canonical.push(...labels);
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help: true,
        description: "Annotate manifest with wikidata labels"
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs.createWriteStream
    });
    parser.add_argument('-l', '--locale', {
        default: 'en-US',
        help: `BGP 47 locale tag of the natural language being processed (defaults to en-US).`
    });
    parser.add_argument('--timezone', {
        required: false,
        default: undefined,
        help: `Timezone to use to interpret dates and times (defaults to the current timezone).`
    });
    parser.add_argument('--thingpedia', {
        required: true,
        help: 'Path to ThingTalk file containing class definitions.'
    });
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--save-cache', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--bootleg-db', {
        required: false,
        default: 'bootleg.sqlite'
    });
    parser.add_argument('--max-count', {
        required: false,
        type: Number,
        default: 5,
        help: `The maximum number of canonicals to include`
    });
    const args = parser.parse_args();
    const tpClient = new Tp.FileClient({ thingpedia: args.thingpedia, locale: args.locale });
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null, true);
    const classDefs = await Promise.all((await tpClient.getDeviceList()).map(async (device) => schemas.getFullMeta(device.primary_kind)));
    const wikidata = new WikidataUtils(args.cache, args.bootleg_db, args.save_cache);

    for (const classDef of classDefs) {
        for (const query of Object.values(classDef.queries)) {
            await addQueryWikidataAltLabels(wikidata, query);
            for (const argDef of query.iterateArguments())
                await addArgumentWikidataAltLabels(wikidata, argDef);
        }
        args.output.write(classDef.prettyprint() + '\n');
    }
    args.output.end();
    await waitFinish(args.output);
}

main();