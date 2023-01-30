import WikidataUtils from '../../utils/wikidata';
import * as fs from 'fs';

export default class VirtualPropertyGenerator {
  private _kb : WikidataUtils;
  private _rankedProperties;

  constructor(kb : WikidataUtils) {
      this._kb = kb;
      this._rankedProperties = JSON.parse(fs.readFileSync('virtual_property_order.json', { encoding: 'utf8' }));
  }

  async getPropertiesForVirtualProperty(propertyAbstractionPath : string, entity : string, property : string, utterance : string, useGPT3 : boolean) {
      if (!useGPT3) {
          const propertyIds = await this._kb.getConnectedProperty(entity);
          const properties = Object.values(await this._kb.getLabelsByBatch(...propertyIds));

          const rankedProperties = this._rankedProperties[property];

          const filteredProperties = properties.filter((item) => rankedProperties.includes(item));

          return filteredProperties.slice().sort((a, b) => rankedProperties.indexOf(a) - rankedProperties.indexOf(b));
      } else {
          // GPT-3 path. Still in progress
          return [];
      }
  }
}