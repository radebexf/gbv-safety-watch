/**
 * GBV Safety Watch - Root Application Component
 *
 * Entry point for the React Native application.
 *
 * NOTE: This currently renders the BluetoothTestScreen so a real MOYOUNG /
 * Da Fit smartwatch can be scanned and connected for a first device test.
 * The onboarding flow and monitoring dashboard will replace this once the
 * remaining UI tasks are wired together.
 */

import React from 'react';

import BluetoothTestScreen from './src/components/BluetoothTestScreen';

function App(): React.JSX.Element {
  return <BluetoothTestScreen />;
}

export default App;
