#!/usr/bin/env bash
git checkout fa9b2fd740ced2a22e0e7e913c3bf3934fd08098
rm *.so
rm -r build/
python setup.py build develop
