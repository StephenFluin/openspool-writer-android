import { antennaSpot } from './antenna';

describe('antennaSpot', () => {
  it('uses the position the phone reports, mirrored to the back', () => {
    const spot = antennaSpot('android', { deviceWidth: 76, deviceHeight: 162, antennas: [{ x: 20, y: 45 }] });
    expect(spot).toEqual({ width: 76, height: 162, x: 56, y: 45, source: 'device', platform: 'android' });
  });

  it('falls back to the usual spot when the phone does not say', () => {
    expect(antennaSpot('android', {})).toMatchObject({ source: 'typical', platform: 'android' });
    expect(antennaSpot('web', null)).toMatchObject({ source: 'typical', platform: 'web' });
  });

  it('points iPhones at the top edge', () => {
    expect(antennaSpot('ios', null)).toMatchObject({ platform: 'ios', y: 4 });
  });
});
